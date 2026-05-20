/**
 * ============================================================
 * ECOMMERCE — ORDERS DATA CLEANING
 * Link google sheets: https://docs.google.com/spreadsheets/d/1LJNFW25kYs-CjTatCwIbw6wYKCF29bLOdMa4MeK3OWQ/edit?gid=91633045#gid=91633045
 * ============================================================
 * CÁCH DÙNG:
 *   1. Tạo Google Sheets mới → File → Import → orders_dirty.csv
 *      Đặt tên sheet là "orders_dirty"
 *   2. Extensions → Apps Script → paste file này
 *   3. QUAN TRỌNG: điền ID của 2 Spreadsheet kia vào 2 hằng số bên dưới
 *   4. Run: runOrdersCleaning()
 *
 * TẠI SAO CẦN SPREADSHEET ID?
 *   Orders cần kiểm tra referential integrity:
 *   customer_id trong orders có tồn tại trong customers không?
 *   product_id trong orders có tồn tại trong products không?
 *   → Cần đọc dữ liệu từ 2 spreadsheet khác → cần ID của chúng
 *
 * LẤY ID Ở ĐÂU?
 *   Mở spreadsheet customers → nhìn URL:
 *   https://docs.google.com/spreadsheets/d/[ID_NÀY]/edit
 *   Copy phần [ID_NÀY] và paste vào CUSTOMERS_SPREADSHEET_ID bên dưới
 * ============================================================
 */

// ⚠️ ĐIỀN ID VÀO ĐÂY TRƯỚC KHI CHẠY
const CUSTOMERS_SPREADSHEET_ID = "1Az5TJslLFpjIHX1JIMVbWb2OxQH0_iKe2aFakoTvVLM";
const PRODUCTS_SPREADSHEET_ID  = "1swcJpAeUNpSxNbACNyM1i8fmBK9ErxKc3O1JTATNurE";

const ORD_DATA_COLS = 12; // order_id đến discount_pct
const USD_RATE      = 25000; // tỉ giá quy đổi USD → VND

function runOrdersCleaning() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName("orders_dirty") || ss.getSheets()[0];

  // Kiểm tra ID đã được điền chưa
  if (CUSTOMERS_SPREADSHEET_ID !== "1Az5TJslLFpjIHX1JIMVbWb2OxQH0_iKe2aFakoTvVLM" ||
      PRODUCTS_SPREADSHEET_ID  !== "1swcJpAeUNpSxNbACNyM1i8fmBK9ErxKc3O1JTATNurE") {
    SpreadsheetApp.getUi().alert(
      "⚠️ Chưa điền Spreadsheet ID!\n\n" +
      "Mở file → Extensions → Apps Script\n" +
      "Tìm 2 dòng CUSTOMERS_SPREADSHEET_ID và PRODUCTS_SPREADSHEET_ID\n" +
      "Paste ID của từng spreadsheet vào"
    );
    return;
  }

  Logger.log("=== BẮT ĐẦU LÀM SẠCH ORDERS ===");

  // Đọc valid IDs từ 2 spreadsheet khác để kiểm tra referential integrity
  // SpreadsheetApp.openById() = mở spreadsheet khác bằng ID
  // → cần quyền access: file đó phải thuộc cùng Google account hoặc đã share
  Logger.log("Đang đọc valid IDs từ Customers & Products...");
  const validCusIds = getValidIds(CUSTOMERS_SPREADSHEET_ID, "customers_clean", "customer_id");
  const validPrdIds = getValidIds(PRODUCTS_SPREADSHEET_ID,  "products_clean",  "product_id");
  Logger.log(`Valid customers: ${validCusIds.size} | Valid products: ${validPrdIds.size}`);

  deleteSheetIfExists(ss, "orders_clean");
  deleteSheetIfExists(ss, "Cleaning_Log");
  deleteSheetIfExists(ss, "Flagged");

  const cleanSheet = getOrCreateSheet(ss, "orders_clean");
  const logSheet   = getOrCreateSheet(ss, "Cleaning_Log");
  const flagSheet  = getOrCreateSheet(ss, "Flagged");

  cleanOrdersData(rawSheet, cleanSheet, logSheet, flagSheet, validCusIds, validPrdIds);

  SpreadsheetApp.getUi().alert("✅ Orders cleaning xong!\nXem: orders_clean, Cleaning_Log, Flagged");
}


// ── Đọc valid IDs từ spreadsheet khác ────────────────────────────
// Trả về Set chứa tất cả giá trị trong cột idCol của sheet sheetName
function getValidIds(spreadsheetId, sheetName, idCol) {
  try {
    const ss    = SpreadsheetApp.openById(spreadsheetId);
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      Logger.log(`⚠️ Không tìm thấy sheet "${sheetName}" trong ${spreadsheetId}`);
      return new Set();
    }
    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    const colIdx  = headers.indexOf(idCol); // tìm vị trí cột theo tên
    if (colIdx < 0) {
      Logger.log(`⚠️ Không tìm thấy cột "${idCol}" trong ${sheetName}`);
      return new Set();
    }
    // Lấy tất cả giá trị trong cột idCol (bỏ header)
    const ids = data.slice(1).map(row => row[colIdx]).filter(v => v !== "");
    return new Set(ids);
  } catch(e) {
    Logger.log(`⚠️ Lỗi khi đọc ${spreadsheetId}: ${e.message}`);
    return new Set();
  }
}


function cleanOrdersData(rawSheet, cleanSheet, logSheet, flagSheet, validCusIds, validPrdIds) {

  const data    = rawSheet.getRange(1, 1, rawSheet.getLastRow(), ORD_DATA_COLS).getValues();
  const headers = data[0];
  const rows    = data.slice(1);

  const colIdx = {};
  headers.forEach((h, i) => colIdx[h] = i);

  // Thêm 3 cột phái sinh từ parse shipping_address JSON
  const extraCols   = ["addr_street", "addr_district", "addr_city", "amount_after_discount"];
  const allHeaders  = [...headers, ...extraCols];
  const logHeaders  = ["row_original", "field", "old_value", "new_value", "action"];
  const flagHeaders = ["row_id", "flag_type", "field", "value", "note"];

  const cleanRows  = [];
  const logEntries = [logHeaders];
  const flagRows   = [];
  const seenIds    = new Set();
  let   rowNum     = 2;


  rows.forEach((row) => {
    const r     = [...row];
    const ordId = r[colIdx["order_id"]];


    // ════════════════════════════════════════════════════════════
    // BƯỚC 1: DUPLICATE
    // ════════════════════════════════════════════════════════════
    if (seenIds.has(ordId)) {
      logEntries.push([rowNum, "order_id", ordId, "", "DROPPED_DUPLICATE"]);
      rowNum++; return;
    }
    seenIds.add(ordId);


    // ════════════════════════════════════════════════════════════
    // BƯỚC 2: REFERENTIAL INTEGRITY — cross-table validation
    // Kiểm tra foreign key có tồn tại trong master data không
    // Đây là loại lỗi chỉ phát hiện được khi có nhiều bảng
    // ════════════════════════════════════════════════════════════
    const cusId = r[colIdx["customer_id"]];
    const prdId = r[colIdx["product_id"]];

    if (validCusIds.size > 0 && !validCusIds.has(cusId)) {
      // customer_id không tồn tại trong customers_clean → đơn hàng mồ côi
      flagRows.push([ordId, "ORPHAN_ORDER", "customer_id", cusId,
        `customer_id "${cusId}" không tồn tại trong customers — cần xác nhận hoặc xóa đơn`]);
    }
    if (validPrdIds.size > 0 && !validPrdIds.has(prdId)) {
      // product_id không tồn tại trong products_clean → đơn hàng mồ côi
      flagRows.push([ordId, "ORPHAN_ORDER", "product_id", prdId,
        `product_id "${prdId}" không tồn tại trong products — sản phẩm đã xóa?`]);
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 3: CURRENCY — Chỉ đổi flag currency → VND
    //
    // Tại sao KHÔNG nhân unit_price × USD_RATE?
    //   Cột tên là "unit_price_vnd" → đã là VND rồi, chỉ bị gán nhầm currency
    //   Ví dụ: unit_price=773,000 (VND), total=34.01 (USD nhầm) → currency=USD
    //   Nếu nhân unit_price × 25,000 → ra 19,325,000,000 (sai hoàn toàn)
    //
    // Giải pháp đúng:
    //   Bước 3: chỉ đổi currency = "VND", ghi log
    //   Bước 6: tính lại total = unit_price × quantity (đã có logic này)
    //   → total tự được tính đúng từ unit_price_vnd đã là VND
    // ════════════════════════════════════════════════════════════
    const currency = String(r[colIdx["currency"]] || "").trim().toUpperCase();
    if (currency === "USD") {
      const oldTotal = r[colIdx["total_amount"]];
      // Ghi log: total cũ (giá trị USD sai) → sẽ được tính lại ở Bước 6
      logEntries.push([rowNum, "currency", "USD", "VND", "CURRENCY_FIXED"]);
      logEntries.push([rowNum, "total_amount", oldTotal, "(tính lại từ unit_price × qty)", "TOTAL_WILL_RECALCULATE"]);
      // Chỉ đổi currency — không chạm unit_price, không chạm total
      // Bước 6 sẽ phát hiện total sai và tính lại tự động
      r[colIdx["currency"]] = "VND";
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 4: ORDER_DATE & SHIP_DATE — parse nhiều format
    // ════════════════════════════════════════════════════════════
    const rawOrder = r[colIdx["order_date"]];
    const rawShip  = r[colIdx["ship_date"]];

    const parsedOrder = parseViDate(rawOrder instanceof Date
      ? Utilities.formatDate(rawOrder, "UTC", "dd/MM/yyyy") : String(rawOrder || ""));
    const parsedShip  = parseViDate(rawShip instanceof Date
      ? Utilities.formatDate(rawShip,  "UTC", "dd/MM/yyyy") : String(rawShip  || ""));

    let orderFormatted = "", shipFormatted = "";

    if (parsedOrder) {
      orderFormatted = Utilities.formatDate(parsedOrder, "UTC", "yyyy-MM-dd");
      if (String(rawOrder) !== orderFormatted) {
        logEntries.push([rowNum, "order_date", rawOrder, orderFormatted, "DATE_NORMALIZED"]);
      }
      r[colIdx["order_date"]] = orderFormatted;
    }
    if (parsedShip) {
      shipFormatted = Utilities.formatDate(parsedShip, "UTC", "yyyy-MM-dd");
      if (String(rawShip) !== shipFormatted) {
        logEntries.push([rowNum, "ship_date", rawShip, shipFormatted, "DATE_NORMALIZED"]);
      }
      r[colIdx["ship_date"]] = shipFormatted;
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 5: CROSS-COLUMN — ship_date trước order_date
    // ════════════════════════════════════════════════════════════
    if (parsedOrder && parsedShip && parsedShip < parsedOrder) {
      logEntries.push([rowNum, "ship_date × order_date",
        `ship=${shipFormatted}`, `order=${orderFormatted}`, "SHIP_BEFORE_ORDER"]);
      flagRows.push([ordId, "SHIP_BEFORE_ORDER", "ship_date × order_date",
        `ship=${shipFormatted}, order=${orderFormatted}`,
        "ship_date trước order_date — bất khả thi, cần xác nhận"]);
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 6: PARSE NUMBER AN TOÀN + TÍNH LẠI TOTAL
    //
    // Vấn đề: Sheets đôi khi tự parse số trong CSV thành Date object
    //   "3.45" → Date | "0" → 0 (ok) | "" → NaN
    // Hàm safeNumber() xử lý tất cả các trường hợp:
    //   Date object → lấy giá trị timestamp → flag bất thường
    //   String/number → parseFloat bình thường
    //   Kết quả NaN → trả 0, ghi flag
    // ════════════════════════════════════════════════════════════

    // Helper: đọc giá trị số an toàn từ ô có thể là Date object
    function safeNumber(val) {
      if (val instanceof Date && !isNaN(val.getTime())) {
        // Sheets parse nhầm thành Date → lấy lại ngày.tháng như weight_kg
        // Nhưng với số tiền, Date object thường là lỗi thực sự → trả NaN
        return NaN;
      }
      const n = parseFloat(String(val || "").trim().replace(",", "."));
      return isNaN(n) ? 0 : n;
    }

    let unitPrice = safeNumber(r[colIdx["unit_price_vnd"]]);
    const qty     = parseInt(r[colIdx["quantity"]]) || 0;
    let total     = safeNumber(r[colIdx["total_amount"]]);

    // Flag unit_price bất thường (quá lớn > 100 triệu hoặc âm hoặc 0)
    if (unitPrice <= 0 || isNaN(unitPrice)) {
      flagRows.push([ordId, "PRICE_INVALID", "unit_price_vnd",
        r[colIdx["unit_price_vnd"]], "Giá đơn vị không hợp lệ (≤0 hoặc không đọc được)"]);
      unitPrice = 0;
    } else if (unitPrice > 100000000) {
      // > 100 triệu → nghi nhầm đơn vị hoặc nhập sai
      flagRows.push([ordId, "PRICE_OUTLIER", "unit_price_vnd",
        unitPrice, "Giá đơn vị bất thường (> 100 triệu) — outlier, cần xem xét ở EDA"]);
    }

    // Ghi lại dạng number sạch — tránh .0 dạng string, tránh Date object
    r[colIdx["unit_price_vnd"]] = unitPrice;

    // Tính lại total nếu không khớp unit_price × qty (cho phép sai số 1%)
    if (unitPrice > 0 && qty > 0) {
      const expected = unitPrice * qty;
      if (isNaN(total) || Math.abs(total - expected) > expected * 0.01) {
        logEntries.push([rowNum, "total_amount", total, expected, "TOTAL_RECALCULATED"]);
        total = expected;
      }
    }
    // Ghi lại dạng number sạch
    r[colIdx["total_amount"]] = total;


    // ════════════════════════════════════════════════════════════
    // BƯỚC 7: DISCOUNT_PCT — null → fill 0
    // ════════════════════════════════════════════════════════════
    if (r[colIdx["discount_pct"]] === "" || r[colIdx["discount_pct"]] === null) {
      logEntries.push([rowNum, "discount_pct", "", 0, "FILLED_NULL"]);
      r[colIdx["discount_pct"]] = 0;
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 8: SHIPPING_ADDRESS — parse JSON → tách thành 3 cột
    //
    // 3 tình huống xử lý:
    //   [A] JSON hợp lệ → parse bình thường → lấy street, district, city
    //   [B] JSON thiếu "}" → thêm "}" vào cuối → thử parse lại
    //       VD: '{"street":"...","city":"Hà Nội"' → thêm '}' → parse OK
    //       Ghi log ADDRESS_FIXED để biết đã tự sửa
    //   [C] Rỗng hoàn toàn → fill "Không xác định" cho cả 3 cột
    // ════════════════════════════════════════════════════════════
    const rawAddr = String(r[colIdx["shipping_address"]] || "").trim();
    let   addrStreet = "Không xác định";
    let   addrDistrict = "Không xác định";
    let   addrCity   = "Không xác định";

    if (!rawAddr) {
      // [C] Rỗng → fill Không xác định (đã set ở trên), ghi log
      logEntries.push([rowNum, "shipping_address", "", "Không xác định", "ADDRESS_MISSING"]);

    } else {
      // Thử parse JSON — xử lý cả broken JSON
      let parsed = null;

      // Bước 1: thử parse trực tiếp
      try {
        parsed = JSON.parse(rawAddr);
      } catch(e1) {
        // Parse thất bại → thử sửa

        // Bước 2: thêm "}" nếu thiếu
        // Kiểm tra: chuỗi bắt đầu "{" nhưng không kết thúc "}"
        if (rawAddr.startsWith("{") && !rawAddr.endsWith("}")) {
          try {
            parsed = JSON.parse(rawAddr + "}");
            // Sửa thành công → ghi log để audit
            logEntries.push([rowNum, "shipping_address",
              rawAddr, rawAddr + "}", "ADDRESS_FIXED"]);
          } catch(e2) {
            // Vẫn không parse được sau khi thêm "}" → JSON lỗi nặng hơn
            parsed = null;
          }
        }
      }

      if (parsed) {
        // Parse thành công (dù có sửa hay không) → lấy 3 trường
        addrStreet   = parsed.street   || "Không xác định";
        addrDistrict = parsed.district || "Không xác định";
        addrCity     = parsed.city     || "Không xác định";
      } else {
        // Thực sự không parse được → flag để review
        // Giữ "Không xác định" cho 3 cột (đã set ở trên)
        flagRows.push([ordId, "ADDRESS_INVALID", "shipping_address", rawAddr,
          "JSON lỗi không sửa được — cần xác nhận thủ công"]);
      }
    }


    // ════════════════════════════════════════════════════════════
    // DERIVED COLUMNS — Tính amount_after_discount
    // ════════════════════════════════════════════════════════════
    const finalTotal   = parseFloat(r[colIdx["total_amount"]]) || 0;
    const discountPct  = parseFloat(r[colIdx["discount_pct"]])  || 0;
    const afterDiscount = Math.round(finalTotal * (1 - discountPct / 100) / 100) * 100;

    // Push 4 cột phái sinh tương ứng extraCols
    r.push(addrStreet, addrDistrict, addrCity, afterDiscount);

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

  Logger.log(`✅ Clean: ${cleanRows.length} | Log: ${logEntries.length-1} | Flagged: ${flagRows.length}`);
}


// ── HELPERS ───────────────────────────────────────────────────────
function parseViDate(str) {
  if (!str || str === "") return null;
  if (str instanceof Date) return isNaN(str.getTime()) ? null : str;
  str = String(str).trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [y,mo,d] = [+m[1],+m[2],+m[3]];
    if (!isValidParts(d,mo,y)) return null;
    return new Date(Date.UTC(y, mo-1, d));
  }
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const [p1,p2,y] = [+m[1],+m[2],+m[3]];
    if (isValidParts(p1,p2,y)) return new Date(Date.UTC(y, p2-1, p1));
    if (isValidParts(p2,p1,y)) return new Date(Date.UTC(y, p1-1, p2));
    return null;
  }

  // Format DD/MM/YY hoặc DD-MM-YY (năm 2 chữ số)
  // VD: "04/12/23" → 2023-12-04 | yy > 50 → 19xx, ≤ 50 → 20xx
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m) {
    const p1 = +m[1], p2 = +m[2], yy = +m[3];
    const y  = yy > 50 ? 1900 + yy : 2000 + yy;
    if (isValidParts(p1,p2,y)) return new Date(Date.UTC(y, p2-1, p1));
  }
  return null;
}
function isValidParts(d, mo, y) {
  if (mo<1||mo>12||d<1||d>31||y<2000||y>2100) return false;
  const t = new Date(Date.UTC(y,mo-1,d));
  return t.getUTCFullYear()===y && t.getUTCMonth()===mo-1 && t.getUTCDate()===d;
}
function deleteSheetIfExists(ss, name) {
  const s = ss.getSheetByName(name);
  if (!s) return;
  if (ss.getSheets().length===1) { s.clearContents(); return; }
  ss.deleteSheet(s);
}
function getOrCreateSheet(ss, name) {
  let s = ss.getSheetByName(name);
  if (!s) s = ss.insertSheet(name);
  return s;
}
