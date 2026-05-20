/**
 * ============================================================
 * ECOMMERCE — PRODUCTS DATA CLEANING
 * Link google sheets: https://docs.google.com/spreadsheets/d/1swcJpAeUNpSxNbACNyM1i8fmBK9ErxKc3O1JTATNurE/edit?gid=1912405573#gid=1912405573
 * ============================================================
 * CÁCH DÙNG:
 *   1. Tạo Google Sheets mới → File → Import → products_dirty.csv
 *      Đặt tên sheet là "products_dirty"
 *   2. Extensions → Apps Script → paste file này
 *   3. Run: runProductsCleaning()
 * ============================================================
 */

const PROD_DATA_COLS = 7; // product_id, product_name, category, price_vnd, stock_qty, weight_kg, status

function runProductsCleaning() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName("products_dirty") || ss.getSheets()[0];

  Logger.log("=== BẮT ĐẦU LÀM SẠCH PRODUCTS ===");

  deleteSheetIfExists(ss, "products_clean");
  deleteSheetIfExists(ss, "Cleaning_Log");
  deleteSheetIfExists(ss, "Flagged");

  const cleanSheet = getOrCreateSheet(ss, "products_clean");
  const logSheet   = getOrCreateSheet(ss, "Cleaning_Log");
  const flagSheet  = getOrCreateSheet(ss, "Flagged");

  cleanProductsData(rawSheet, cleanSheet, logSheet, flagSheet);

  SpreadsheetApp.getUi().alert("✅ Products cleaning xong!\nXem: products_clean, Cleaning_Log, Flagged");
}


function cleanProductsData(rawSheet, cleanSheet, logSheet, flagSheet) {

  const data    = rawSheet.getRange(1, 1, rawSheet.getLastRow(), PROD_DATA_COLS).getValues();
  const headers = data[0];
  const rows    = data.slice(1);

  const colIdx = {};
  headers.forEach((h, i) => colIdx[h] = i);

  const allHeaders  = [...headers];
  const logHeaders  = ["row_original", "field", "old_value", "new_value", "action"];
  const flagHeaders = ["row_id", "flag_type", "field", "value", "note"];

  const cleanRows  = [];
  const logEntries = [logHeaders];
  const flagRows   = [];
  const seenIds    = new Set();
  let   rowNum     = 2;


  rows.forEach((row) => {
    const r    = [...row];
    const prdId = r[colIdx["product_id"]];


    // ════════════════════════════════════════════════════════════
    // BƯỚC 1: DUPLICATE
    // ════════════════════════════════════════════════════════════
    if (seenIds.has(prdId)) {
      logEntries.push([rowNum, "product_id", prdId, "", "DROPPED_DUPLICATE"]);
      rowNum++; return;
    }
    seenIds.add(prdId);


    // ════════════════════════════════════════════════════════════
    // BƯỚC 2: STATUS — normalize active/Active/ACTIVE → lowercase
    // Nguyên tắc: lowercase là chuẩn cho categorical flag
    // ════════════════════════════════════════════════════════════
    const rawStatus   = String(r[colIdx["status"]] || "").trim();
    const cleanStatus = rawStatus ? rawStatus.toLowerCase() : "unknown";
    if (rawStatus !== cleanStatus) {
      logEntries.push([rowNum, "status", rawStatus, cleanStatus, "STATUS_NORMALIZED"]);
    }
    r[colIdx["status"]] = cleanStatus;


    // ════════════════════════════════════════════════════════════
    // BƯỚC 3: PRICE_VND — validate, flag bất thường
    // Nguyên tắc: không tự sửa giá — không biết giá đúng là bao nhiêu
    // ════════════════════════════════════════════════════════════
    const price = parseFloat(r[colIdx["price_vnd"]]);

    if (!isNaN(price)) {
      if (price < 0) {
        // Giá âm → flag, không sửa
        // Lý do: không tự lấy abs() vì không chắc dấu âm là lỗi hay có ý nghĩa
        flagRows.push([prdId, "PRICE_NEGATIVE", "price_vnd", price,
          "Giá âm — cần xác nhận giá đúng trước khi sửa"]);
      } else if (price === 0) {
        // Giá = 0 → flag, có thể là sản phẩm miễn phí hoặc lỗi nhập
        flagRows.push([prdId, "PRICE_ZERO", "price_vnd", price,
          "Giá bằng 0 — sản phẩm miễn phí hay lỗi nhập?"]);
      }
      // Ghi lại dạng number để Sheets hiểu đúng kiểu
      r[colIdx["price_vnd"]] = Math.round(price);
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 4: STOCK_QTY — âm → set 0, flag
    // Nguyên tắc: tồn kho không thể âm trong thực tế
    // Sửa về 0 (không phải null) vì 0 = "hết hàng" có nghĩa rõ ràng
    // ════════════════════════════════════════════════════════════
    const stock = parseInt(r[colIdx["stock_qty"]]);
    if (!isNaN(stock) && stock < 0) {
      logEntries.push([rowNum, "stock_qty", stock, 0, "STOCK_NEGATIVE_ZEROED"]);
      flagRows.push([prdId, "STOCK_NEGATIVE", "stock_qty", stock,
        "Stock âm → set 0. Cần kiểm tra lại tồn kho thực tế"]);
      r[colIdx["stock_qty"]] = 0;
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 5: WEIGHT_KG — parse an toàn, xử lý Date object và string lạ
    //
    // Vấn đề: Google Sheets tự parse weight khi import CSV
    //   "14.02" → Date object (14 tháng 2) vì Sheets nhầm dấu chấm thành ngày
    //   "14/02" → Date object (14 tháng 2) vì Sheets nhầm dấu slash thành ngày
    //
    // Giải pháp:
    //   [A] Date object → lấy ngày và tháng ra → ghép thành số thập phân
    //       VD: Date(14/02/2026) → ngày=14, tháng=2 → "14.02" → 14.02
    //   [B] String số hợp lệ → parseFloat bình thường
    //   [C] Không parse được → flag
    // ════════════════════════════════════════════════════════════
    const rawWeight = r[colIdx["weight_kg"]];
    let   weight    = NaN;
    let   weightLog = null; // lưu giá trị gốc để ghi log nếu có chuyển đổi

    if (rawWeight instanceof Date && !isNaN(rawWeight.getTime())) {
      // [A] Sheets parse nhầm thành Date object
      // Lấy ngày và tháng theo UTC → ghép thành số thập phân
      // VD: Date(2026-02-14) → getUTCDate()=14, getUTCMonth()+1=2 → "14.02" → 14.02
      const day   = rawWeight.getUTCDate();
      const month = rawWeight.getUTCMonth() + 1; // getUTCMonth() trả 0-11 → +1
      const reconstructed = parseFloat(day + "." + String(month).padStart(2, "0"));
      // padStart(2,"0"): đảm bảo tháng luôn 2 chữ số: 2 → "02", 10 → "10"
      weightLog = Utilities.formatDate(rawWeight, "UTC", "dd/MM/yyyy") + " (date object)";
      weight    = reconstructed;
      logEntries.push([rowNum, "weight_kg", weightLog, weight, "WEIGHT_DATE_PARSED"]);

    } else {
      // [B] String hoặc number → parseFloat bình thường
      // String(...) đảm bảo không lỗi khi null/undefined
      const weightStr = String(rawWeight || "").trim().replace(",", ".");
      // replace(",", "."): xử lý số dùng dấu phẩy thập phân "14,02" → "14.02"
      weight = parseFloat(weightStr);
    }

    if (!isNaN(weight)) {
      if (weight <= 0) {
        // Weight ≤ 0 không hợp lý — flag để review
        flagRows.push([prdId, "WEIGHT_INVALID", "weight_kg", weight, "Cân nặng ≤ 0 — không hợp lệ"]);
      }
      // Làm tròn 2 chữ số thập phân cho gọn
      r[colIdx["weight_kg"]] = Math.round(weight * 100) / 100;
    } else {
      // [C] Không parse được → flag
      flagRows.push([prdId, "WEIGHT_UNPARSEABLE", "weight_kg", rawWeight,
        "Không đọc được giá trị cân nặng — cần xác nhận"]);
      r[colIdx["weight_kg"]] = "";
    }

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


// ── HELPERS (dùng chung, copy từ customers) ──────────────────────
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
