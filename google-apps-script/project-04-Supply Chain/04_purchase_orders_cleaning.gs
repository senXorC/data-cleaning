/**
 * ============================================================
 * PROJECT 04 — SUPPLY CHAIN: PURCHASE ORDERS CLEANING
 * ============================================================
 * CÁCH DÙNG:
 *   1. Tạo Google Sheets mới → File → Import → purchase_orders_dirty.csv
 *      Đặt tên sheet là "purchase_orders_dirty"
 *   2. Extensions → Apps Script → paste toàn bộ file này
 *   3. Điền 2 Spreadsheet ID bên dưới (chạy suppliers + inventory trước)
 *   4. Run: runPurchaseOrdersCleaning()
 *
 * OUTPUT 3 SHEET:
 *   purchase_orders_clean : dữ liệu sạch
 *   Cleaning_Log          : audit trail mọi thay đổi
 *   Flagged               : dòng cần review
 *
 * CÁC BƯỚC XỬ LÝ:
 *   1. Duplicate
 *   2. Referential integrity: supplier_id → suppliers_clean
 *   3. Currency: USD → đổi flag, tính lại total ở bước 8
 *   4. Order date + Expected date: parse nhiều format
 *   5. Cross-column: expected_date trước order_date
 *   6. Status: 8 cách viết → lowercase chuẩn
 *   7. Unit_cost: validate giá trị hợp lệ
 *   8. Total_amount: tính lại nếu total ≠ qty × unit_cost
 * ============================================================
 */


// ── HẰNG SỐ ──────────────────────────────────────────────────────
const PO_DATA_COLS = 11; // po_id → notes = 11 cột
const PO_USD_RATE  = 25000; // tỉ giá quy đổi USD → VND

// ⚠️ ĐIỀN ID TRƯỚC KHI CHẠY
// Lấy ID từ URL: https://docs.google.com/spreadsheets/d/[ID]/edit
const PO_SUPPLIERS_SPREADSHEET_ID = "PASTE_SUPPLIERS_SPREADSHEET_ID_HERE";
const PO_INVENTORY_SPREADSHEET_ID  = "PASTE_INVENTORY_SPREADSHEET_ID_HERE";


// ╔══════════════════════════════════════════════════════════════╗
// ║  ENTRY POINT                                                 ║
// ╚══════════════════════════════════════════════════════════════╝

function runPurchaseOrdersCleaning() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName("purchase_orders_dirty") || ss.getSheets()[0];

  // Kiểm tra ID đã điền chưa
  if (PO_SUPPLIERS_SPREADSHEET_ID === "PASTE_SUPPLIERS_SPREADSHEET_ID_HERE" ||
      PO_INVENTORY_SPREADSHEET_ID  === "PASTE_INVENTORY_SPREADSHEET_ID_HERE") {
    SpreadsheetApp.getUi().alert(
      "⚠️ Chưa điền Spreadsheet ID!\n\n" +
      "Cần điền:\n" +
      "- PO_SUPPLIERS_SPREADSHEET_ID\n" +
      "- PO_INVENTORY_SPREADSHEET_ID"
    );
    return;
  }

  Logger.log("=== BẮT ĐẦU LÀM SẠCH PURCHASE ORDERS ===");

  // Đọc valid IDs từ 2 bảng master data đã clean
  // Purchase orders phụ thuộc cả suppliers VÀ inventory
  const validSupIds  = getValidIds(PO_SUPPLIERS_SPREADSHEET_ID, "suppliers_clean",  "supplier_id");
  const validItemIds = getValidIds(PO_INVENTORY_SPREADSHEET_ID,  "inventory_clean",  "item_id");
  Logger.log("Valid suppliers: " + validSupIds.size + " | Valid items: " + validItemIds.size);

  deleteSheetIfExists(ss, "purchase_orders_clean");
  deleteSheetIfExists(ss, "Cleaning_Log");
  deleteSheetIfExists(ss, "Flagged");

  const cleanSheet = getOrCreateSheet(ss, "purchase_orders_clean");
  const logSheet   = getOrCreateSheet(ss, "Cleaning_Log");
  const flagSheet  = getOrCreateSheet(ss, "Flagged");

  cleanPurchaseOrdersData(rawSheet, cleanSheet, logSheet, flagSheet, validSupIds, validItemIds);

  SpreadsheetApp.getUi().alert("✅ Purchase Orders cleaning xong!\nXem: purchase_orders_clean, Cleaning_Log, Flagged");
}


// ── Đọc valid IDs từ spreadsheet khác ────────────────────────────
// Hàm tái sử dụng — dùng cho cả suppliers và inventory
function getValidIds(spreadsheetId, sheetName, idColName) {
  try {
    const ss    = SpreadsheetApp.openById(spreadsheetId);
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      Logger.log("⚠️ Không tìm thấy sheet: " + sheetName);
      return new Set();
    }
    const data   = sheet.getDataRange().getValues();
    const colIdx = data[0].indexOf(idColName);
    if (colIdx < 0) {
      Logger.log("⚠️ Không tìm thấy cột: " + idColName);
      return new Set();
    }
    const ids = data.slice(1).map(r => r[colIdx]).filter(v => v !== "");
    return new Set(ids);
  } catch(e) {
    Logger.log("⚠️ Lỗi khi đọc " + sheetName + ": " + e.message);
    return new Set();
  }
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  HÀM LÀM SẠCH CHÍNH                                         ║
// ╚══════════════════════════════════════════════════════════════╝

function cleanPurchaseOrdersData(rawSheet, cleanSheet, logSheet, flagSheet, validSupIds, validItemIds) {

  // ── ĐỌC DỮ LIỆU ─────────────────────────────────────────────
  const data    = rawSheet.getRange(1, 1, rawSheet.getLastRow(), PO_DATA_COLS).getValues();
  const headers = data[0];
  const rows    = data.slice(1);

  const colIdx = {};
  headers.forEach((h, i) => colIdx[h] = i);

  const logHeaders  = ["row_original", "field", "old_value", "new_value", "action"];
  const flagHeaders = ["po_id", "flag_type", "field", "value", "note"];

  const cleanRows  = [];
  const logEntries = [logHeaders];
  const flagRows   = [];
  const seenIds    = new Set();
  let   rowNum     = 2;


  rows.forEach((row) => {
    const r    = [...row];
    const poId = r[colIdx["po_id"]];


    // ════════════════════════════════════════════════════════════
    // BƯỚC 1: DUPLICATE
    // ════════════════════════════════════════════════════════════
    if (seenIds.has(poId)) {
      logEntries.push([rowNum, "po_id", poId, "", "DROPPED_DUPLICATE"]);
      rowNum++; return;
    }
    seenIds.add(poId);


    // ════════════════════════════════════════════════════════════
    // BƯỚC 2: REFERENTIAL INTEGRITY
    //
    // Purchase orders phụ thuộc vào 2 bảng master:
    //   supplier_id → phải có trong suppliers_clean
    //   item_id     → phải có trong inventory_clean
    //
    // Nếu supplier không tồn tại → PO mồ côi (orphan)
    //   Có thể: NCC đã bị xóa, hoặc nhập sai ID
    //   Không drop dòng — PO đã được tạo trong lịch sử
    //   Chỉ flag để người review xem xét
    // ════════════════════════════════════════════════════════════
    const supId  = r[colIdx["supplier_id"]];
    const itemId = r[colIdx["item_id"]];

    if (validSupIds.size > 0 && !validSupIds.has(supId)) {
      flagRows.push([poId, "ORPHAN_PO", "supplier_id", supId,
        "supplier_id không tồn tại trong suppliers_clean — NCC đã xóa hay nhập sai?"]);
    }
    if (validItemIds.size > 0 && !validItemIds.has(itemId)) {
      flagRows.push([poId, "ORPHAN_PO", "item_id", itemId,
        "item_id không tồn tại trong inventory_clean — item đã xóa hay nhập sai?"]);
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 3: CURRENCY — Chỉ đổi flag, không nhân giá
    //
    // Bài học từ Project 03:
    //   unit_cost_vnd tên cột đã nói rõ đơn vị là VND
    //   Dù currency ghi USD → unit_cost_vnd vẫn là VND thật sự
    //   Lỗi chỉ ở cột currency và total_amount
    //
    // Xử lý:
    //   Bước 3: đổi currency = "VND", ghi log
    //   Bước 8: tính lại total = unit_cost × quantity (tự động fix total sai)
    //
    // Không nhân unit_cost × 25,000 vì:
    //   unit_cost_vnd = 100,000 VND thực → × 25,000 = 2,500,000,000 (sai)
    // ════════════════════════════════════════════════════════════
    const currency = String(r[colIdx["currency"]] || "").trim().toUpperCase();
    if (currency === "USD") {
      logEntries.push([rowNum, "currency", "USD", "VND", "CURRENCY_FIXED"]);
      logEntries.push([rowNum, "total_amount", r[colIdx["total_amount"]],
        "(tính lại từ unit_cost × qty)", "TOTAL_WILL_RECALCULATE"]);
      // Chỉ đổi flag — không chạm unit_cost_vnd và total_amount
      // Bước 8 sẽ tính lại total tự động
      r[colIdx["currency"]] = "VND";
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 4: PARSE NGÀY — order_date và expected_date
    //
    // Hỗ trợ 4 format: YYYY-MM-DD, DD/MM/YYYY, D/M/YYYY, DD-MM-YYYY
    // Lưu kết quả vào biến parsedOrderDate, parsedExpectedDate
    // để dùng ở Bước 5 (cross-column validation)
    // ════════════════════════════════════════════════════════════
    const rawOrderRaw = r[colIdx["order_date"]];
    const rawExpRaw   = r[colIdx["expected_date"]];

    // Sheets tự parse thành Date object khi import CSV
    // → chuyển về string trước để parseViDate() xử lý đồng nhất
    const rawOrder = rawOrderRaw instanceof Date
      ? Utilities.formatDate(rawOrderRaw, "UTC", "dd/MM/yyyy")
      : String(rawOrderRaw || "");
    const rawExp   = rawExpRaw instanceof Date
      ? Utilities.formatDate(rawExpRaw, "UTC", "dd/MM/yyyy")
      : String(rawExpRaw || "");

    const parsedOrder = parseViDate(rawOrder);
    const parsedExp   = parseViDate(rawExp);

    if (parsedOrder) {
      const fmt = Utilities.formatDate(parsedOrder, "UTC", "yyyy-MM-dd");
      if (rawOrder !== fmt) logEntries.push([rowNum, "order_date", rawOrder, fmt, "DATE_NORMALIZED"]);
      r[colIdx["order_date"]] = fmt;
    }
    if (parsedExp) {
      const fmt = Utilities.formatDate(parsedExp, "UTC", "yyyy-MM-dd");
      if (rawExp !== fmt) logEntries.push([rowNum, "expected_date", rawExp, fmt, "DATE_NORMALIZED"]);
      r[colIdx["expected_date"]] = fmt;
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 5: CROSS-COLUMN — expected_date trước order_date
    //
    // Ràng buộc logic: expected_date (ngày dự kiến nhận hàng)
    // phải SAU order_date (ngày đặt hàng)
    // → Không thể nhận hàng trước khi đặt hàng
    //
    // Không tự sửa — không biết cột nào sai
    // Có thể: nhập nhầm 2 ngày, hoặc format bị đọc sai
    // → Flag để người review xác nhận
    // ════════════════════════════════════════════════════════════
    if (parsedOrder && parsedExp && parsedExp < parsedOrder) {
      const orderFmt = Utilities.formatDate(parsedOrder, "UTC", "yyyy-MM-dd");
      const expFmt   = Utilities.formatDate(parsedExp,   "UTC", "yyyy-MM-dd");
      logEntries.push([rowNum,
        "expected_date × order_date",   // tên cặp cột → dấu hiệu cross-column check
        "order=" + orderFmt,
        "expected=" + expFmt,
        "EXPECTED_BEFORE_ORDER"
      ]);
      flagRows.push([poId, "EXPECTED_BEFORE_ORDER",
        "expected_date × order_date",
        "order=" + orderFmt + ", expected=" + expFmt,
        "Ngày nhận hàng (" + expFmt + ") trước ngày đặt hàng (" + orderFmt + ") — bất khả thi"
      ]);
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 6: STATUS — 8 cách viết → lowercase chuẩn
    //
    // Giá trị hợp lệ: pending, approved, received, cancelled
    // Chuẩn hoá về lowercase để nhất quán:
    //   "PENDING" → "pending", "Approved" → "approved"
    //
    // Tại sao lowercase thay vì Title Case?
    //   Status thường được dùng trong filter/group by
    //   Lowercase là convention phổ biến hơn trong database
    //   Nhất quán với project 03 (e-commerce orders)
    // ════════════════════════════════════════════════════════════
    const rawStatus   = String(r[colIdx["status"]] || "").trim();
    const cleanStatus = rawStatus.toLowerCase();
    if (rawStatus !== cleanStatus) {
      logEntries.push([rowNum, "status", rawStatus, cleanStatus, "STATUS_NORMALIZED"]);
    }
    r[colIdx["status"]] = cleanStatus;


    // ════════════════════════════════════════════════════════════
    // BƯỚC 7: UNIT_COST_VND — validate giá trị hợp lệ
    //
    // Tương tự unit_cost trong inventory:
    //   âm → flag (không sửa, không biết giá đúng)
    //   = 0 → flag (miễn phí hay lỗi?)
    //
    // Cần ép kiểu an toàn trước:
    //   Sheets có thể trả về Date object nếu nhập nhầm format
    //   safeNumber() xử lý cả Date object, string, number
    // ════════════════════════════════════════════════════════════
    const rawCost = r[colIdx["unit_cost_vnd"]];
    let   unitCost = NaN;

    if (rawCost instanceof Date) {
      // Sheets parse nhầm số thành Date → giá trị không hợp lệ → flag
      flagRows.push([poId, "COST_PARSE_ERROR", "unit_cost_vnd",
        "(date object)", "unit_cost_vnd bị Sheets parse thành Date — cần xem lại giá trị gốc"]);
      unitCost = 0;
    } else {
      unitCost = parseFloat(String(rawCost || "0").replace(",", ".")) || 0;
      // replace(",", ".") → xử lý số dùng dấu phẩy thập phân "10,500" → 10.5
    }

    if (unitCost < 0) {
      flagRows.push([poId, "COST_NEGATIVE", "unit_cost_vnd", unitCost,
        "Giá đơn vị âm — cần xác nhận giá thực tế"]);
    } else if (unitCost === 0) {
      flagRows.push([poId, "COST_ZERO", "unit_cost_vnd", 0,
        "Giá đơn vị = 0 — cần xác nhận"]);
    }

    r[colIdx["unit_cost_vnd"]] = Math.round(unitCost);


    // ════════════════════════════════════════════════════════════
    // BƯỚC 8: TOTAL_AMOUNT — tính lại nếu không khớp
    //
    // Công thức: total = unit_cost_vnd × quantity
    // Cho phép sai số 1% (làm tròn hàng nghìn VND)
    //
    // Tại sao tính lại thay vì chỉ flag?
    //   total sai là lỗi kỹ thuật rõ ràng — biết công thức đúng
    //   Khác reorder/max_stock: không biết số nào đúng
    //   Đây: unit_cost × quantity là công thức chắc chắn
    //   → Tự sửa được, ghi log để audit trail
    //
    // Cũng xử lý trường hợp USD:
    //   Sau Bước 3: currency đã đổi sang VND
    //   total cũ có thể là giá USD (ví dụ: 34.01)
    //   → expected = unit_cost_vnd × qty (VND) → total sai → tính lại
    // ════════════════════════════════════════════════════════════
    const qty      = parseInt(r[colIdx["quantity"]]) || 0;
    const rawTotal = parseFloat(String(r[colIdx["total_amount"]] || "0").replace(",", ".")) || 0;
    const expected = unitCost * qty;

    if (unitCost > 0 && qty > 0) {
      // Kiểm tra sai số: |total - expected| > 1% expected
      const diff = Math.abs(rawTotal - expected);
      if (diff > expected * 0.01) {
        logEntries.push([rowNum, "total_amount", rawTotal, expected, "TOTAL_RECALCULATED"]);
        r[colIdx["total_amount"]] = Math.round(expected);
        // Math.round() → số nguyên, tránh "18525000.0" dạng float
      } else {
        // Total đúng rồi nhưng vẫn ép sang số nguyên cho nhất quán
        r[colIdx["total_amount"]] = Math.round(rawTotal);
      }
    } else {
      // unitCost = 0 hoặc qty = 0 → ép sang integer nếu có thể
      if (!isNaN(rawTotal)) r[colIdx["total_amount"]] = Math.round(rawTotal);
    }


    cleanRows.push(r);
    rowNum++;
  });


  // ── GHI KẾT QUẢ ──────────────────────────────────────────────
  cleanSheet.clearContents();
  cleanSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (cleanRows.length > 0) {
    cleanSheet.getRange(2, 1, cleanRows.length, headers.length).setValues(cleanRows);
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

// ── Parse ngày Việt Nam — hỗ trợ D/M/YYYY (1-2 chữ số) ──────────
function parseViDate(str) {
  if (!str || str === "") return null;
  if (str instanceof Date) return isNaN(str.getTime()) ? null : str;
  str = String(str).trim();

  // Format YYYY-MM-DD
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    if (!isValidDateParts(d, mo, y)) return null;
    return new Date(Date.UTC(y, mo - 1, d));
  }

  // Format D/M/YYYY hoặc DD/MM/YYYY hoặc DD-MM-YYYY
  // \d{1,2} = 1 hoặc 2 chữ số → nhận cả "1/5/2023" và "01/05/2023"
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const [p1, p2, y] = [+m[1], +m[2], +m[3]];
    if (isValidDateParts(p1, p2, y)) return new Date(Date.UTC(y, p2 - 1, p1));
    if (isValidDateParts(p2, p1, y)) return new Date(Date.UTC(y, p1 - 1, p2));
    return null;
  }

  // Format DD/MM/YY (năm 2 chữ số)
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m) {
    const [p1, p2, yy] = [+m[1], +m[2], +m[3]];
    const y = yy > 50 ? 1900 + yy : 2000 + yy;
    if (isValidDateParts(p1, p2, y)) return new Date(Date.UTC(y, p2 - 1, p1));
    return null;
  }

  return null;
}

function isValidDateParts(d, mo, y) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
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
