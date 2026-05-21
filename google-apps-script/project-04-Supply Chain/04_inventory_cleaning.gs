/**
 * ============================================================
 * PROJECT 04 — SUPPLY CHAIN: INVENTORY CLEANING
 * ============================================================
 * CÁCH DÙNG:
 *   1. Tạo Google Sheets mới → File → Import → inventory_dirty.csv
 *      Đặt tên sheet là "inventory_dirty"
 *   2. Extensions → Apps Script → paste toàn bộ file này
 *   3. Chạy suppliers cleaning TRƯỚC để có SUPPLIERS_SPREADSHEET_ID
 *   4. Điền SUPPLIERS_SPREADSHEET_ID vào hằng số bên dưới
 *   5. Run: runInventoryCleaning()
 *
 * OUTPUT 3 SHEET:
 *   inventory_clean : dữ liệu sạch + cột phái sinh needs_reorder
 *   Cleaning_Log    : audit trail mọi thay đổi
 *   Flagged         : dòng cần review (cross-column, cost lỗi...)
 *
 * KỸ THUẬT MỚI:
 *   - Bộ 3 cross-column: stock_qty / reorder_point / max_stock
 *     Mỗi cột có ràng buộc riêng VÀ ràng buộc với nhau
 *   - Referential integrity: supplier_id có tồn tại trong suppliers không?
 *   - Derived column: needs_reorder (stock_qty <= reorder_point)
 *     Đây là thông tin nghiệp vụ hữu ích, không phải lỗi
 * ============================================================
 */


// ── HẰNG SỐ ──────────────────────────────────────────────────────
const INV_DATA_COLS = 11; // item_id → supplier_id = 11 cột

// ⚠️ ĐIỀN ID CỦA SPREADSHEET SUPPLIERS (đã clean) VÀO ĐÂY
// Lấy ID từ URL: https://docs.google.com/spreadsheets/d/[ID_NÀY]/edit
const SUPPLIERS_SPREADSHEET_ID = "PASTE_SUPPLIERS_SPREADSHEET_ID_HERE";


// ╔══════════════════════════════════════════════════════════════╗
// ║  ENTRY POINT                                                 ║
// ╚══════════════════════════════════════════════════════════════╝

function runInventoryCleaning() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName("inventory_dirty") || ss.getSheets()[0];

  // Kiểm tra ID đã điền chưa
  if (SUPPLIERS_SPREADSHEET_ID === "PASTE_SUPPLIERS_SPREADSHEET_ID_HERE") {
    SpreadsheetApp.getUi().alert(
      "⚠️ Chưa điền Suppliers Spreadsheet ID!\n\n" +
      "Mở file → Extensions → Apps Script\n" +
      "Tìm dòng SUPPLIERS_SPREADSHEET_ID\n" +
      "Paste ID của suppliers spreadsheet vào"
    );
    return;
  }

  Logger.log("=== BẮT ĐẦU LÀM SẠCH INVENTORY ===");

  // Đọc valid supplier IDs từ suppliers_clean để kiểm tra referential integrity
  // Inventory phải chạy SAU suppliers vì cần dữ liệu suppliers đã clean
  Logger.log("Đang đọc valid supplier IDs từ suppliers_clean...");
  const validSupIds = getValidSupplierIds(SUPPLIERS_SPREADSHEET_ID);
  Logger.log("Valid suppliers: " + validSupIds.size);

  deleteSheetIfExists(ss, "inventory_clean");
  deleteSheetIfExists(ss, "Cleaning_Log");
  deleteSheetIfExists(ss, "Flagged");

  const cleanSheet = getOrCreateSheet(ss, "inventory_clean");
  const logSheet   = getOrCreateSheet(ss, "Cleaning_Log");
  const flagSheet  = getOrCreateSheet(ss, "Flagged");

  cleanInventoryData(rawSheet, cleanSheet, logSheet, flagSheet, validSupIds);

  SpreadsheetApp.getUi().alert("✅ Inventory cleaning xong!\nXem: inventory_clean, Cleaning_Log, Flagged");
}


// ── Đọc valid supplier IDs từ spreadsheet suppliers đã clean ─────
// Tương tự getValidIds() trong orders cleaning project 03
// Mở spreadsheet khác bằng ID → đọc cột supplier_id → trả về Set
function getValidSupplierIds(spreadsheetId) {
  try {
    const ss    = SpreadsheetApp.openById(spreadsheetId);
    // openById() = mở spreadsheet khác — cần quyền access (cùng Google account)
    const sheet = ss.getSheetByName("suppliers_clean");
    if (!sheet) {
      Logger.log("⚠️ Không tìm thấy sheet suppliers_clean");
      return new Set();
    }
    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    const colIdx  = headers.indexOf("supplier_id");
    if (colIdx < 0) {
      Logger.log("⚠️ Không tìm thấy cột supplier_id");
      return new Set();
    }
    // Lấy tất cả supplier_id từ cột đó (bỏ header)
    const ids = data.slice(1).map(row => row[colIdx]).filter(v => v !== "");
    return new Set(ids);
  } catch(e) {
    Logger.log("⚠️ Lỗi khi đọc suppliers: " + e.message);
    return new Set();  // trả Set rỗng → sẽ skip referential integrity check
  }
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  HÀM LÀM SẠCH CHÍNH                                         ║
// ╚══════════════════════════════════════════════════════════════╝

function cleanInventoryData(rawSheet, cleanSheet, logSheet, flagSheet, validSupIds) {

  // ── ĐỌC DỮ LIỆU ─────────────────────────────────────────────
  const data    = rawSheet.getRange(1, 1, rawSheet.getLastRow(), INV_DATA_COLS).getValues();
  const headers = data[0];
  const rows    = data.slice(1);

  const colIdx = {};
  headers.forEach((h, i) => colIdx[h] = i);

  const logHeaders  = ["row_original", "field", "old_value", "new_value", "action"];
  const flagHeaders = ["item_id", "item_name", "flag_type", "field", "value", "note"];

  // Thêm cột phái sinh needs_reorder vào output
  // needs_reorder: TRUE khi stock_qty <= reorder_point → cần đặt hàng
  // Đây là THÔNG TIN, không phải lỗi → không vào Flagged, vào Clean để analyst dùng
  const extraCols  = ["needs_reorder"];
  const allHeaders = [...headers, ...extraCols];

  const cleanRows  = [];
  const logEntries = [logHeaders];
  const flagRows   = [];
  const seenIds    = new Set();
  let   rowNum     = 2;


  rows.forEach((row) => {
    const r      = [...row];
    const itemId = r[colIdx["item_id"]];
    const itemName = String(r[colIdx["item_name"]] || "").trim();


    // ════════════════════════════════════════════════════════════
    // BƯỚC 1: DUPLICATE
    // ════════════════════════════════════════════════════════════
    if (seenIds.has(itemId)) {
      logEntries.push([rowNum, "item_id", itemId, "", "DROPPED_DUPLICATE"]);
      rowNum++; return;
    }
    seenIds.add(itemId);


    // ════════════════════════════════════════════════════════════
    // BƯỚC 2: REFERENTIAL INTEGRITY — supplier_id có tồn tại không?
    //
    // Inventory có cột supplier_id (NCC chính cung cấp item này)
    // Nếu supplier_id không có trong suppliers_clean → dữ liệu mồ côi
    //
    // Không drop dòng — inventory item vẫn tồn tại trong kho
    // Chỉ flag để người review xem xét: NCC đã bị xóa? Nhập sai ID?
    // ════════════════════════════════════════════════════════════
    const supId = r[colIdx["supplier_id"]];
    if (validSupIds.size > 0 && !validSupIds.has(supId)) {
      // validSupIds.size > 0: chỉ check khi đọc được suppliers (tránh false positive)
      flagRows.push([itemId, itemName, "ORPHAN_ITEM", "supplier_id", supId,
        "supplier_id không tồn tại trong suppliers — NCC đã xóa hay nhập sai ID?"]);
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 3: ĐỌC VÀ ÉP KIỂU 3 CỘT SỐ QUAN TRỌNG
    //
    // Đọc trước khi validate — cần cả 3 giá trị để kiểm tra chéo
    // parseFloat() → đọc số từ string/number
    // isNaN() → kiểm tra xem có phải số hợp lệ không
    // ════════════════════════════════════════════════════════════
    let stockQty    = parseFloat(r[colIdx["stock_qty"]]);
    let reorderPt   = parseFloat(r[colIdx["reorder_point"]]);
    let maxStock    = parseFloat(r[colIdx["max_stock"]]);

    // Làm tròn về số nguyên — tồn kho không có số lẻ
    stockQty  = isNaN(stockQty)  ? 0 : Math.round(stockQty);
    reorderPt = isNaN(reorderPt) ? 0 : Math.round(reorderPt);
    maxStock  = isNaN(maxStock)  ? 0 : Math.round(maxStock);


    // ════════════════════════════════════════════════════════════
    // BƯỚC 4: VALIDATE stock_qty
    //
    // Ràng buộc: stock_qty >= 0
    //   Tồn kho âm không thể xảy ra trong thực tế
    //   → Set 0 (hết hàng) + flag để review nguyên nhân
    //
    // Ràng buộc: stock_qty <= max_stock
    //   Kho không thể chứa nhiều hơn sức chứa tối đa
    //   → Không sửa vì không biết số nào sai → chỉ flag
    // ════════════════════════════════════════════════════════════
    if (stockQty < 0) {
      // Lỗi kỹ thuật rõ ràng: âm → set 0
      logEntries.push([rowNum, "stock_qty", stockQty, 0, "STOCK_NEGATIVE_ZEROED"]);
      flagRows.push([itemId, itemName, "STOCK_NEGATIVE", "stock_qty", stockQty,
        "Tồn kho âm → đã set 0. Cần kiểm tra lại movement history để tìm nguyên nhân"]);
      stockQty = 0;
    }

    if (stockQty > maxStock && maxStock > 0) {
      // Lỗi nghiệp vụ: tồn kho vượt sức chứa
      // Không sửa: không biết stock_qty sai hay max_stock sai
      // Có thể max_stock được nhập thấp hơn thực tế khi migrate dữ liệu
      flagRows.push([itemId, itemName, "STOCK_EXCEED_MAX", "stock_qty",
        "stock=" + stockQty + " > max=" + maxStock,
        "Tồn kho (" + stockQty + ") vượt sức chứa tối đa (" + maxStock + ") — cần xác nhận lại max_stock"]);
    }

    r[colIdx["stock_qty"]] = stockQty;


    // ════════════════════════════════════════════════════════════
    // BƯỚC 5: VALIDATE reorder_point và max_stock
    //
    // Ràng buộc bộ 3: 0 < reorder_point < max_stock
    //
    // reorder_point >= max_stock là lỗi nghiệp vụ nghiêm trọng:
    //   Đặt hàng khi còn N đơn vị → nhưng kho chỉ chứa tối đa M < N
    //   → Điều kiện đặt hàng không bao giờ được kích hoạt → kho hết hàng
    //
    // Không tự sửa vì: không biết reorder_point sai hay max_stock sai
    //   Cả 2 đều có thể đúng từ góc nhìn của người nhập liệu
    //   → Flag để kho trưởng xác nhận
    // ════════════════════════════════════════════════════════════
    if (reorderPt >= maxStock && maxStock > 0) {
      flagRows.push([itemId, itemName, "REORDER_GT_MAX",
        "reorder_point × max_stock",
        "reorder=" + reorderPt + " >= max=" + maxStock,
        "reorder_point (" + reorderPt + ") ≥ max_stock (" + maxStock + ") — " +
        "hệ thống tự động đặt hàng sẽ không hoạt động. Cần xem lại cấu hình kho"]);
    }

    r[colIdx["reorder_point"]] = reorderPt;
    r[colIdx["max_stock"]]     = maxStock;


    // ════════════════════════════════════════════════════════════
    // BƯỚC 6: UNIT_COST_VND — validate giá trị hợp lệ
    //
    // unit_cost <= 0:
    //   = 0 → sản phẩm miễn phí? hay lỗi nhập liệu? → flag
    //   < 0 → lỗi nhập liệu rõ ràng → flag
    //   Không tự sửa: không biết giá đúng là bao nhiêu
    //
    // Khác stock_qty: stock âm → set 0 vì biết ý nghĩa (hết hàng)
    //                 cost âm → không biết giá đúng → chỉ flag
    // ════════════════════════════════════════════════════════════
    const unitCost = parseFloat(r[colIdx["unit_cost_vnd"]]);

    if (!isNaN(unitCost)) {
      if (unitCost < 0) {
        flagRows.push([itemId, itemName, "COST_NEGATIVE", "unit_cost_vnd", unitCost,
          "Giá đơn vị âm — cần xác nhận giá thực tế"]);
      } else if (unitCost === 0) {
        flagRows.push([itemId, itemName, "COST_ZERO", "unit_cost_vnd", 0,
          "Giá đơn vị = 0 — sản phẩm miễn phí hay lỗi nhập liệu?"]);
      }
      // Ghi lại dạng number — tránh string "100000" gây lỗi khi tính toán sau này
      r[colIdx["unit_cost_vnd"]] = Math.round(unitCost);
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 7: WAREHOUSE_LOCATION — xử lý null/rỗng/khoảng trắng
    //
    // 56% dòng bị null hoặc trống — đây là vấn đề lớn nhất của inventory
    // Nguyên nhân: dữ liệu chưa được nhập đầy đủ khi migrate từ Excel
    //
    // Xử lý: fill "Không xác định" thay vì để null
    // Lý do:
    //   null trong CSV → pandas/SQL coi là missing value → bị loại khỏi filter
    //   "Không xác định" → vẫn được đếm, có thể group by → thấy được quy mô vấn đề
    // ════════════════════════════════════════════════════════════
    const rawLoc   = String(r[colIdx["warehouse_location"]] || "").trim();
    const cleanLoc = rawLoc || "Không xác định";
    // rawLoc || "Không xác định": nếu rawLoc là "" (rỗng) → dùng "Không xác định"

    if (!rawLoc) {
      // Chỉ log khi thực sự bị null/rỗng
      logEntries.push([rowNum, "warehouse_location", "", "Không xác định", "LOCATION_FILLED"]);
    }
    r[colIdx["warehouse_location"]] = cleanLoc;


    // ════════════════════════════════════════════════════════════
    // BƯỚC 8: LAST_UPDATED — chuẩn hoá format ngày
    //
    // Tương tự các project trước — parse nhiều format → YYYY-MM-DD
    // Khác: không drop dòng khi parse thất bại
    //        mỗi dòng = 1 item kho, không xóa vì 1 cột lỗi
    // ════════════════════════════════════════════════════════════
    const rawDate    = r[colIdx["last_updated"]];
    const rawDateStr = rawDate instanceof Date
      ? Utilities.formatDate(rawDate, "UTC", "dd/MM/yyyy")
      // Sheets tự parse thành Date object khi import → chuyển về string trước
      : String(rawDate || "");

    const parsedDate = parseViDate(rawDateStr);
    if (parsedDate) {
      const formatted = Utilities.formatDate(parsedDate, "UTC", "yyyy-MM-dd");
      if (rawDateStr !== formatted) {
        logEntries.push([rowNum, "last_updated", rawDateStr, formatted, "DATE_NORMALIZED"]);
      }
      r[colIdx["last_updated"]] = formatted;
    }
    // Nếu parse thất bại → giữ nguyên giá trị gốc


    // ════════════════════════════════════════════════════════════
    // BƯỚC 9 — DERIVED COLUMN: needs_reorder
    //
    // needs_reorder = TRUE khi stock_qty <= reorder_point
    // Nghĩa nghiệp vụ: tồn kho đã đến ngưỡng cần đặt hàng lại
    //
    // Đây là THÔNG TIN hữu ích cho analyst, không phải lỗi:
    //   → Không vào Flagged (Flagged = lỗi cần fix)
    //   → Vào Clean để analyst biết ngay item nào cần đặt hàng
    //   → Thay vì analyst phải tự tính: WHERE stock_qty <= reorder_point
    //
    // Dùng "Có" / "Không" thay vì TRUE/FALSE
    // → Tránh Sheets parse thành boolean (vấn đề tương tự is_active)
    // ════════════════════════════════════════════════════════════
    const needsReorder = (stockQty <= reorderPt && reorderPt > 0) ? "Có" : "Không";
    // Điều kiện phụ reorderPt > 0: tránh false positive khi reorder_point = 0


    // Thêm cột phái sinh vào cuối hàng — tương ứng với extraCols
    r.push(needsReorder);

    cleanRows.push(r);
    rowNum++;
  });


  // ── GHI KẾT QUẢ ──────────────────────────────────────────────
  cleanSheet.clearContents();
  cleanSheet.getRange(1, 1, 1, allHeaders.length).setValues([allHeaders]);
  if (cleanRows.length > 0) {
    cleanSheet.getRange(2, 1, cleanRows.length, allHeaders.length).setValues(cleanRows);
  }

  logSheet.clearContents();
  logSheet.getRange(1, 1, logEntries.length, logEntries[0].length).setValues(logEntries);

  flagSheet.clearContents();
  flagSheet.getRange(1, 1, 1, flagHeaders.length).setValues([flagHeaders]);
  if (flagRows.length > 0) {
    flagSheet.getRange(2, 1, flagRows.length, flagHeaders.length).setValues(flagRows);
  }

  Logger.log("✅ Clean: " + cleanRows.length +
             " | Log: " + (logEntries.length - 1) +
             " | Flagged: " + flagRows.length);
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  HELPERS                                                     ║
// ╚══════════════════════════════════════════════════════════════╝

// ── Parse ngày Việt Nam ───────────────────────────────────────────
// Hỗ trợ 4 format: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, D/M/YYYY
// Dùng Date.UTC() để tránh lệch ngày do timezone server Google
function parseViDate(str) {
  if (!str || str === "") return null;
  if (str instanceof Date) return isNaN(str.getTime()) ? null : str;
  str = String(str).trim();

  // Format 1: YYYY-MM-DD
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    if (!isValidDateParts(d, mo, y)) return null;
    return new Date(Date.UTC(y, mo - 1, d));
  }

  // Format 2 & 3: D/M/YYYY hoặc DD/MM/YYYY hoặc DD-MM-YYYY
  // \d{1,2} = 1 hoặc 2 chữ số → nhận cả "1/5/2023" và "01/05/2023"
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const [p1, p2, y] = [+m[1], +m[2], +m[3]];
    // Thử DD/MM (chuẩn Việt Nam) trước
    if (isValidDateParts(p1, p2, y)) return new Date(Date.UTC(y, p2 - 1, p1));
    // Thử MM/DD nếu DD/MM thất bại
    if (isValidDateParts(p2, p1, y)) return new Date(Date.UTC(y, p1 - 1, p2));
    return null;
  }

  return null;
}

// ── Validate ngày/tháng/năm ───────────────────────────────────────
// Tránh JS tự overflow: new Date(2024, 13, 1) → JS tính sang năm sau
function isValidDateParts(d, mo, y) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return false;
  const test = new Date(Date.UTC(y, mo - 1, d));
  return test.getUTCFullYear() === y && test.getUTCMonth() === mo - 1 && test.getUTCDate() === d;
}

function deleteSheetIfExists(ss, name) {
  const s = ss.getSheetByName(name);
  if (!s) return;
  if (ss.getSheets().length === 1) { s.clearContents(); return; }
  ss.deleteSheet(s);
}

function getOrCreateSheet(ss, name) {
  let s = ss.getSheetByName(name);
  if (!s) s = ss.insertSheet(name);
  return s;
}
