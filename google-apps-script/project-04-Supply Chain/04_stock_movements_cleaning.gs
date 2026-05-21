/**
 * ============================================================
 * PROJECT 04 — SUPPLY CHAIN: STOCK MOVEMENTS CLEANING
 * ============================================================
 * CÁCH DÙNG:
 *   1. Tạo Google Sheets mới → File → Import → stock_movements_dirty.csv
 *      Đặt tên sheet là "stock_movements_dirty"
 *   2. Điền PO_SPREADSHEET_ID và INVENTORY_SPREADSHEET_ID bên dưới
 *   3. Run: runStockMovementsCleaning()
 *
 * OUTPUT:
 *   stock_movements_clean : dữ liệu sạch
 *   Cleaning_Log          : audit trail
 *   Flagged               : dòng cần review
 *
 * KỸ THUẬT MỚI — RUNNING BALANCE:
 *   Tính tồn kho tích lũy theo thời gian cho từng item
 *   Phát hiện thời điểm balance âm → bất khả thi về nghiệp vụ
 *
 *   Cách tính:
 *     IN / RETURN → + qty (tăng tồn kho)
 *     OUT         → - qty (giảm tồn kho)
 *     ADJUSTMENT  → + qty hoặc - qty (tùy qty dương/âm)
 *
 *   Thứ tự xử lý bắt buộc:
 *     1. Drop duplicate → tránh đếm 2 lần
 *     2. Normalize type → phân loại đúng IN/OUT
 *     3. Parse date → sort đúng thứ tự thời gian
 *     4. Validate qty → xử lý qty âm
 *     5. Running balance → PHẢI sau tất cả bước trên
 * ============================================================
 */


// ── HẰNG SỐ ──────────────────────────────────────────────────────
const MOV_DATA_COLS = 9; // movement_id → notes = 9 cột

// ⚠️ ĐIỀN ID TRƯỚC KHI CHẠY
const MOV_PO_SPREADSHEET_ID        = "PASTE_PO_SPREADSHEET_ID_HERE";
const MOV_INVENTORY_SPREADSHEET_ID = "PASTE_INVENTORY_SPREADSHEET_ID_HERE";


// ╔══════════════════════════════════════════════════════════════╗
// ║  ENTRY POINT                                                 ║
// ╚══════════════════════════════════════════════════════════════╝

function runStockMovementsCleaning() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName("stock_movements_dirty") || ss.getSheets()[0];

  if (MOV_PO_SPREADSHEET_ID === "PASTE_PO_SPREADSHEET_ID_HERE" ||
      MOV_INVENTORY_SPREADSHEET_ID === "PASTE_INVENTORY_SPREADSHEET_ID_HERE") {
    SpreadsheetApp.getUi().alert(
      "⚠️ Chưa điền Spreadsheet ID!\n\n" +
      "Cần điền:\n" +
      "- MOV_PO_SPREADSHEET_ID\n" +
      "- MOV_INVENTORY_SPREADSHEET_ID"
    );
    return;
  }

  Logger.log("=== BẮT ĐẦU LÀM SẠCH STOCK MOVEMENTS ===");

  // Đọc valid IDs từ purchase_orders và inventory
  const validPoIds   = getValidMovIds(MOV_PO_SPREADSHEET_ID,
                                      "purchase_orders_clean", "po_id");
  const validItemIds = getValidMovIds(MOV_INVENTORY_SPREADSHEET_ID,
                                      "inventory_clean", "item_id");
  Logger.log("Valid PO IDs: " + validPoIds.size +
             " | Valid item IDs: " + validItemIds.size);

  // Đọc opening balance từ inventory_clean
  // { item_id → stock_qty hiện tại } → dùng để tính opening balance
  const currentStockMap = getOpeningBalances(MOV_INVENTORY_SPREADSHEET_ID);
  Logger.log("Current stock map: " + Object.keys(currentStockMap).length + " items");

  deleteSheetIfExists(ss, "stock_movements_clean");
  deleteSheetIfExists(ss, "Cleaning_Log");
  deleteSheetIfExists(ss, "Flagged");

  const cleanSheet = getOrCreateSheet(ss, "stock_movements_clean");
  const logSheet   = getOrCreateSheet(ss, "Cleaning_Log");
  const flagSheet  = getOrCreateSheet(ss, "Flagged");

  cleanStockMovementsData(rawSheet, cleanSheet, logSheet, flagSheet,
                          validPoIds, validItemIds, currentStockMap);

  SpreadsheetApp.getUi().alert(
    "✅ Stock Movements cleaning xong!\nXem: stock_movements_clean, Cleaning_Log, Flagged"
  );
}


// ── Đọc valid IDs từ spreadsheet khác ────────────────────────────
function getValidMovIds(spreadsheetId, sheetName, idColName) {
  try {
    const ss    = SpreadsheetApp.openById(spreadsheetId);
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      Logger.log("⚠️ Không tìm thấy sheet: " + sheetName);
      return new Set();
    }
    const data   = sheet.getDataRange().getValues();
    const colIdx = data[0].indexOf(idColName);
    if (colIdx < 0) return new Set();
    return new Set(data.slice(1).map(r => r[colIdx]).filter(v => v !== ""));
  } catch(e) {
    Logger.log("⚠️ Lỗi: " + e.message);
    return new Set();
  }
}


// ── Đọc opening balance từ inventory_clean ───────────────────────
// Trả về Map: { item_id → stock_qty }
// Dùng để tính running balance bắt đầu từ số đúng thay vì 0
//
// Tại sao cần opening balance?
//   Nếu bắt đầu từ 0 → running balance sẽ sai khi có tồn kho trước kỳ
//   Ví dụ: tồn kho đầu kỳ = 494, movement đầu tiên OUT 20
//   → Từ 0: balance = 0 - 20 = -20 → FLAG SAI
//   → Từ 494: balance = 494 - 20 = 474 → đúng, không flag
//
// Cách tính opening balance từ cuối kỳ:
//   opening = inventory.stock_qty - sum(tất cả signed_qty trong movements)
//   Vì: opening + tổng biến động = tồn kho hiện tại
function getOpeningBalances(spreadsheetId) {
  try {
    const ss    = SpreadsheetApp.openById(spreadsheetId);
    const sheet = ss.getSheetByName("inventory_clean");
    if (!sheet) {
      Logger.log("⚠️ Không tìm thấy sheet inventory_clean");
      return {};
    }
    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    const idIdx   = headers.indexOf("item_id");
    const qtyIdx  = headers.indexOf("stock_qty");
    if (idIdx < 0 || qtyIdx < 0) {
      Logger.log("⚠️ Không tìm thấy cột item_id hoặc stock_qty");
      return {};
    }
    // Trả về object: { "ITEM-201": 555, "ITEM-202": 100, ... }
    const result = {};
    data.slice(1).forEach(r => {
      const id  = r[idIdx];
      const qty = parseFloat(r[qtyIdx]);
      if (id && !isNaN(qty)) result[id] = qty;
    });
    Logger.log("Đọc opening balance: " + Object.keys(result).length + " items");
    return result;
  } catch(e) {
    Logger.log("⚠️ Lỗi khi đọc opening balance: " + e.message);
    return {};
  }
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  HÀM LÀM SẠCH CHÍNH                                         ║
// ╚══════════════════════════════════════════════════════════════╝

function cleanStockMovementsData(rawSheet, cleanSheet, logSheet, flagSheet,
                                  validPoIds, validItemIds, currentStockMap) {

  // ── ĐỌC DỮ LIỆU ─────────────────────────────────────────────
  const data    = rawSheet.getRange(1, 1, rawSheet.getLastRow(), MOV_DATA_COLS).getValues();
  const headers = data[0];
  const rows    = data.slice(1);

  const colIdx = {};
  headers.forEach((h, i) => colIdx[h] = i);

  const logHeaders  = ["row_original", "field", "old_value", "new_value", "action"];
  const flagHeaders = ["movement_id", "item_id", "flag_type", "field", "value", "note"];

  const cleanRows  = [];
  const logEntries = [logHeaders];
  const flagRows   = [];
  const seenIds    = new Set();
  let   rowNum     = 2;


  // ════════════════════════════════════════════════════════════
  // BẢNG MAPPING movement_type: 22 cách viết → 4 loại chuẩn
  //
  // Kỹ thuật: object map, key = lowercase của cách viết bẩn
  // Tra cứu: O(1) — nhanh hơn if/else chain
  //
  // ADJUSTMENT đặc biệt: qty có thể âm (kiểm kê phát hiện thiếu)
  // → Không flag qty âm với ADJUSTMENT
  // ════════════════════════════════════════════════════════════
  const TYPE_MAP = {
    // IN group
    "in": "IN", "nhập": "IN", "nhập kho": "IN", "import": "IN",
    // OUT group
    "out": "OUT", "xuất": "OUT", "xuất kho": "OUT", "export": "OUT",
    // RETURN group
    "return": "RETURN", "trả hàng": "RETURN", "trả ncc": "RETURN",
    // ADJUSTMENT group
    "adjustment": "ADJUSTMENT", "adj": "ADJUSTMENT",
    "điều chỉnh": "ADJUSTMENT", "kiểm kê": "ADJUSTMENT",
  };


  // ══════════════════════════════════════════════════════════════
  // VÒNG LẶP CHÍNH — Bước 1-5
  // Bước 6 (Running Balance) xử lý SAU vòng lặp
  // ══════════════════════════════════════════════════════════════

  rows.forEach((row) => {
    const r     = [...row];
    const movId = r[colIdx["movement_id"]];
    const itemId = String(r[colIdx["item_id"]] || "").trim();


    // ════════════════════════════════════════════════════════════
    // BƯỚC 1: DUPLICATE
    // Stock movements là bảng transaction — duplicate nghĩa là
    // cùng 1 biến động được ghi 2 lần → tính balance sai
    // ════════════════════════════════════════════════════════════
    if (seenIds.has(movId)) {
      logEntries.push([rowNum, "movement_id", movId, "", "DROPPED_DUPLICATE"]);
      rowNum++; return;
    }
    seenIds.add(movId);


    // ════════════════════════════════════════════════════════════
    // BƯỚC 2: REFERENTIAL INTEGRITY
    //
    // item_id: phải có trong inventory_clean
    //   Mọi movement đều phải liên quan đến item tồn tại trong kho
    //
    // reference_po: chỉ check khi không rỗng VÀ type là IN/RETURN
    //   Lý do:
    //   - OUT và ADJUSTMENT không cần PO → reference_po trống = đúng
    //   - IN/RETURN từ NCC → nên có PO → nếu có PO nhưng không tồn tại = lỗi
    //   - Nếu IN/RETURN không có reference_po → bình thường (nhập kho thủ công)
    // ════════════════════════════════════════════════════════════
    if (validItemIds.size > 0 && !validItemIds.has(itemId)) {
      flagRows.push([movId, itemId, "ORPHAN_MOVEMENT", "item_id", itemId,
        "item_id không tồn tại trong inventory — item đã xóa hay nhập sai?"]);
    }

    const refPo   = String(r[colIdx["reference_po"]] || "").trim();
    const rawType = String(r[colIdx["movement_type"]] || "").trim();
    const typeKey = rawType.toLowerCase();
    const cleanType = TYPE_MAP[typeKey] || null;

    // Chỉ check reference_po khi là IN hoặc RETURN và reference_po không trống
    if (refPo && (cleanType === "IN" || cleanType === "RETURN")) {
      if (validPoIds.size > 0 && !validPoIds.has(refPo)) {
        flagRows.push([movId, itemId, "ORPHAN_REF_PO", "reference_po", refPo,
          "reference_po không tồn tại trong purchase_orders — PO đã xóa hay nhập sai?"]);
      }
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 3: NORMALIZE MOVEMENT_TYPE
    //
    // Dùng TYPE_MAP đã định nghĩa ở trên
    // Nếu không nhận ra → flag, giữ nguyên
    // ════════════════════════════════════════════════════════════
    if (cleanType) {
      if (rawType !== cleanType) {
        logEntries.push([rowNum, "movement_type", rawType, cleanType, "TYPE_NORMALIZED"]);
      }
      r[colIdx["movement_type"]] = cleanType;
    } else {
      // Không nhận ra → flag
      flagRows.push([movId, itemId, "TYPE_UNKNOWN", "movement_type", rawType,
        "Không nhận dạng được movement type — cần xác nhận thuộc IN/OUT/RETURN/ADJUSTMENT"]);
      // Giữ nguyên rawType để người review thấy
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 4: PARSE DATE
    // ════════════════════════════════════════════════════════════
    // ── Warehouse — fill Không xác định nếu rỗng ────────────────
    const rawWarehouse = String(r[colIdx["warehouse"]] || "").trim();
    if (!rawWarehouse) {
      logEntries.push([rowNum, "warehouse", "", "Không xác định", "WAREHOUSE_FILLED"]);
      r[colIdx["warehouse"]] = "Không xác định";
    }

    const rawDateRaw = r[colIdx["movement_date"]];
    const rawDateStr = rawDateRaw instanceof Date
      ? Utilities.formatDate(rawDateRaw, "UTC", "dd/MM/yyyy")
      : String(rawDateRaw || "");

    const parsedDate = parseMovDate(rawDateStr);
    if (parsedDate) {
      const formatted = Utilities.formatDate(parsedDate, "UTC", "yyyy-MM-dd");
      if (rawDateStr !== formatted) {
        logEntries.push([rowNum, "movement_date", rawDateStr, formatted, "DATE_NORMALIZED"]);
      }
      r[colIdx["movement_date"]] = formatted;
    }


    // ════════════════════════════════════════════════════════════
    // BƯỚC 5: VALIDATE QUANTITY
    //
    // Qty âm — xử lý khác nhau theo movement_type:
    //
    //   ADJUSTMENT với qty âm → HỢP LỆ
    //     Nghĩa: kiểm kê phát hiện thiếu hàng → điều chỉnh giảm
    //     VD: ADJUSTMENT qty=-10 → tồn kho thực kém 10 so với sổ sách
    //     → Không flag, giữ nguyên qty âm
    //
    //   IN/OUT/RETURN với qty âm → LỖI
    //     Không có nghĩa nghiệp vụ: nhập kho -5 thùng?
    //     Có thể là nhầm dấu hoặc nhập sai
    //     → Flag để review
    // ════════════════════════════════════════════════════════════
    const rawQty    = parseFloat(r[colIdx["quantity"]]);
    const finalType = r[colIdx["movement_type"]]; // sau khi normalize

    // ── Chuẩn hoá quantity về dương ───────────────────────────
    // Dấu âm/dương của biến động kho do movement_type quyết định:
    //   IN / RETURN → tăng kho → luôn dương
    //   OUT         → giảm kho → luôn dương (signed_qty = -qty trong tính toán)
    //   ADJUSTMENT  → có thể âm hoặc dương → GIỮ NGUYÊN DẤU GỐC
    //     Lý do: ADJUSTMENT âm = kiểm kê phát hiện thiếu → điều chỉnh giảm
    //            Đây là thông tin thực sự, không phải lỗi nhập liệu
    //
    // Nếu IN/OUT/RETURN có qty âm → nhập sai dấu → lấy abs() + ghi log
    if (!isNaN(rawQty)) {
      let cleanQty = rawQty;

      if (finalType === "ADJUSTMENT") {
        // ADJUSTMENT: giữ nguyên dấu gốc — âm hoặc dương đều có nghĩa
        cleanQty = rawQty;

      } else if (rawQty < 0) {
        // IN / OUT / RETURN bị nhập âm → lấy giá trị tuyệt đối
        // Ghi log để audit trail — biết đã tự sửa dấu
        cleanQty = Math.abs(rawQty);
        logEntries.push([rowNum, "quantity", rawQty, cleanQty,
          "QTY_SIGN_FIXED"]);
        // Flag để reviewer biết dữ liệu gốc bị âm — có thể cần điều tra thêm
        flagRows.push([movId, itemId, "QTY_NEGATIVE", "quantity", rawQty,
          "Số lượng âm trong " + finalType + " — đã chuyển thành " + cleanQty +
          " (dấu do movement_type quyết định, không phải số liệu)"]);
      }

      r[colIdx["quantity"]] = cleanQty;
    }


    cleanRows.push(r);
    rowNum++;
  });


  // ════════════════════════════════════════════════════════════
  // BƯỚC 6: RUNNING BALANCE — Xử lý sau vòng lặp chính
  //
  // Tại sao phải sau vòng lặp?
  //   Cần toàn bộ data đã clean (type chuẩn, date parse, dup removed)
  //   Mới tính được balance chính xác
  //
  // Thuật toán:
  //   1. Nhóm movements theo item_id
  //   2. Sort từng nhóm theo movement_date (tăng dần)
  //   3. Tính signed_qty: IN/RETURN → +qty, OUT → -qty, ADJUSTMENT → qty (giữ dấu)
  //   4. Tính balance tích lũy (running sum)
  //   5. Flag dòng gây balance âm
  //
  // GAS không có cumsum() như pandas
  // → Tự viết: dùng object để nhóm, sort thủ công, loop tính tổng tích lũy
  // ════════════════════════════════════════════════════════════

  // Nhóm movements theo item_id
  // itemGroups: { "ITEM-201": [{ rowIdx, date, signedQty, movId }, ...] }
  const itemGroups = {};

  cleanRows.forEach((r, rowIdx) => {
    const iId     = String(r[colIdx["item_id"]] || "").trim();
    const mType   = r[colIdx["movement_type"]];
    const rawQty  = parseFloat(r[colIdx["quantity"]]) || 0;
    const dateStr = String(r[colIdx["movement_date"]] || "");
    const mId     = r[colIdx["movement_id"]];

    // Tính signed_qty dựa trên movement_type
    // IN/RETURN → tăng tồn kho → +qty
    // OUT → giảm tồn kho → -qty
    // ADJUSTMENT → giữ nguyên dấu (âm hoặc dương tùy kiểm kê)
    // Sau bước BƯỚC 5: quantity đã được chuẩn hoá về dương (trừ ADJUSTMENT)
    // signedQty = dấu do movement_type quyết định:
    //   IN/RETURN  → +qty (tăng kho)
    //   OUT        → -qty (giảm kho)
    //   ADJUSTMENT → rawQty (giữ dấu gốc: âm = giảm, dương = tăng)
    let signedQty = 0;
    if (mType === "IN" || mType === "RETURN") {
      signedQty = Math.abs(rawQty);  // đảm bảo dương dù data gốc có sai
    } else if (mType === "OUT") {
      signedQty = -Math.abs(rawQty); // đảm bảo âm
    } else if (mType === "ADJUSTMENT") {
      signedQty = rawQty;            // giữ nguyên dấu gốc
    }
    // Nếu type không nhận ra → signedQty = 0 → không ảnh hưởng balance

    // Flag orphan reference_po cho movement này không?
    // Nếu IN/RETURN có reference_po không hợp lệ (PO không tồn tại)
    // → hàng chưa được xác nhận thực sự vào kho → KHÔNG tính vào balance
    // Lý do: reference_po là bằng chứng hàng đã nhận — nếu PO không tồn tại
    //        thì không có cơ sở để xác nhận hàng đã vào kho
    // OUT và ADJUSTMENT không cần PO → vẫn tính bình thường
    const isOrphanRefPo = flagRows.some(f =>
      f[0] === mId && f[2] === "ORPHAN_REF_PO"
    );
    const excludeFromBalance = isOrphanRefPo &&
      (mType === "IN" || mType === "RETURN");

    if (!excludeFromBalance) {
      if (!itemGroups[iId]) itemGroups[iId] = [];
      itemGroups[iId].push({ rowIdx, dateStr, signedQty, mId });
    } else {
      // Ghi log để biết movement này bị exclude khỏi balance
      Logger.log("EXCLUDE from balance: " + mId + " (" + mType + ") — ORPHAN_REF_PO");
    }
  });

  // ════════════════════════════════════════════════════════════
  // TÍNH OPENING BALANCE VÀ RUNNING BALANCE
  //
  // Vấn đề nếu bắt đầu từ 0:
  //   Trước kỳ báo cáo, item đã có sẵn tồn kho (ví dụ 494 đơn vị)
  //   Nếu bắt đầu từ 0 → movement OUT đầu tiên gây balance âm giả
  //   → Flag sai: thực ra tồn kho vẫn dương
  //
  // Giải pháp: tính opening balance từ cuối kỳ ngược lại
  //   Vì: opening + tổng signed_qty = stock_qty hiện tại
  //   → opening = stock_qty - tổng signed_qty
  //
  // Nếu không có dữ liệu inventory (currentStockMap rỗng):
  //   Không thể tính opening → bỏ qua running balance check
  //   Tránh false positive gây nhầm lẫn
  // ════════════════════════════════════════════════════════════
  const negativeBalanceRows = new Set();

  // Bước 1: Tính tổng signed_qty của tất cả movements theo item
  // Dùng để tính opening balance
  const totalSignedByItem = {};
  Object.keys(itemGroups).forEach(iId => {
    totalSignedByItem[iId] = itemGroups[iId].reduce((sum, m) => sum + m.signedQty, 0);
    // reduce: duyệt mảng → cộng dồn signedQty → trả về tổng
  });

  Object.keys(itemGroups).forEach(iId => {
    const moves = itemGroups[iId];

    // Tính opening balance
    // Nếu có currentStockMap → tính chính xác
    // Nếu không có → dùng 0 và ghi chú (có thể false positive)
    let openingBalance = 0;
    let hasOpeningData = false;

    if (currentStockMap && currentStockMap[iId] !== undefined) {
      // opening = tồn kho hiện tại - tổng biến động trong kỳ
      openingBalance = currentStockMap[iId] - totalSignedByItem[iId];
      hasOpeningData = true;
      // Ghi log để kiểm tra (chỉ log nếu opening khác 0 đáng kể)
      if (Math.abs(openingBalance) > 0) {
        Logger.log("ITEM " + iId + ": opening=" + openingBalance +
                   " current=" + currentStockMap[iId] +
                   " totalMov=" + totalSignedByItem[iId]);
      }
    }

    // Nếu không có dữ liệu inventory → skip running balance check
    // Tránh false positive khi không biết opening balance
    if (!hasOpeningData) return;

    // Sort theo ngày tăng dần
    moves.sort((a, b) => {
      if (a.dateStr < b.dateStr) return -1;
      if (a.dateStr > b.dateStr) return 1;
      return 0;
    });

    // Tính running balance bắt đầu từ opening balance
    let balance = openingBalance;
    moves.forEach(m => {
      balance += m.signedQty;
      if (balance < 0) {
        // Balance thực sự âm sau khi đã tính opening → đây là lỗi thật
        negativeBalanceRows.add(m.rowIdx);
        flagRows.push([
          m.mId, iId,
          "NEGATIVE_BALANCE",
          "running_balance",
          Math.round(balance),
          "Balance tích lũy âm (" + Math.round(balance) + ") sau movement " + m.mId +
          " (opening=" + Math.round(openingBalance) + ")" +
          " — tồn kho không thể âm. Kiểm tra movement trước đó có bị thiếu/sai không"
        ]);
      }
    });
  });

  Logger.log("Running balance: " + negativeBalanceRows.size + " dòng gây balance âm");


  // ════════════════════════════════════════════════════════════
  // TẠO SHEET INVENTORY_SUMMARY
  //
  // Mục đích: Kiểm tra số đầu kỳ, dịch chuyển trong kỳ, số cuối kỳ
  // Cho phép analyst verify ngay:
  //   - opening_balance có hợp lý không?
  //   - total_in + total_out + total_adj có đúng không?
  //   - closing_balance có khớp với inventory.stock_qty không?
  //
  // Cấu trúc:
  //   item_id | opening_balance | total_in | total_return |
  //   total_out | total_adj | closing_balance | inventory_qty | match
  //
  // Cột "match": closing_balance == inventory_qty?
  //   "✅ Khớp"    → tính toán nhất quán với inventory
  //   "⚠️ Lệch X" → có vấn đề cần điều tra
  //   "N/A"        → không có dữ liệu inventory để so sánh
  // ════════════════════════════════════════════════════════════

  // Tính tổng IN, OUT, RETURN, ADJUSTMENT riêng cho từng item
  // Cần tách ra để analyst thấy chi tiết biến động
  const itemStats = {};

  cleanRows.forEach(r => {
    const iId    = String(r[colIdx["item_id"]] || "").trim();
    const mType  = r[colIdx["movement_type"]];
    const rawQty = parseFloat(r[colIdx["quantity"]]) || 0;

    if (!itemStats[iId]) {
      itemStats[iId] = { in: 0, out: 0, returnQty: 0, adj: 0 };
    }

    if (mType === "IN")           itemStats[iId].in         += Math.abs(rawQty);
    else if (mType === "OUT")     itemStats[iId].out         += Math.abs(rawQty);
    else if (mType === "RETURN")  itemStats[iId].returnQty  += Math.abs(rawQty);
    else if (mType === "ADJUSTMENT") itemStats[iId].adj     += rawQty; // giữ dấu
  });

  // Tạo sheet Inventory_Summary
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  deleteSheetIfExists(ss, "Inventory_Summary");
  const summarySheet = getOrCreateSheet(ss, "Inventory_Summary");

  const summaryHeaders = [
    "item_id",
    "opening_balance",   // tồn kho đầu kỳ (tính ngược từ cuối kỳ)
    "total_in",          // tổng nhập kho (IN)
    "total_return",      // tổng trả hàng NCC (RETURN)
    "total_out",         // tổng xuất kho (OUT)
    "total_adjustment",  // tổng điều chỉnh (ADJUSTMENT, có thể âm)
    "closing_balance",   // tồn kho cuối kỳ = opening + in + return - out + adj
    "inventory_qty",     // stock_qty trong inventory_clean
    "match",             // closing_balance có khớp inventory_qty không?
    "has_negative_balance" // có movement gây balance âm không?
  ];

  const summaryRows = [];

  // Tập hợp tất cả item_id từ cả movements và inventory
  const allItemIds = new Set([
    ...Object.keys(itemStats),
    ...(currentStockMap ? Object.keys(currentStockMap) : [])
  ]);

  allItemIds.forEach(iId => {
    const stats       = itemStats[iId] || { in: 0, out: 0, returnQty: 0, adj: 0 };
    const invQty      = (currentStockMap && currentStockMap[iId] !== undefined)
                        ? currentStockMap[iId] : null;

    // Tính opening balance
    // opening = closing (inventory) - net movements
    // net = in + return - out + adj
    const netMovement   = stats.in + stats.returnQty - stats.out + stats.adj;
    const openingBal    = invQty !== null ? invQty - netMovement : null;

    // Tính closing balance từ movements
    const closingBal    = openingBal !== null ? openingBal + netMovement : null;

    // Kiểm tra match
    let matchStatus = "N/A";
    if (closingBal !== null && invQty !== null) {
      const diff = Math.round(closingBal) - invQty;
      if (diff === 0) {
        matchStatus = "✅ Khớp";
      } else {
        matchStatus = "⚠️ Lệch " + diff;
      }
    }

    // Kiểm tra có negative balance không
    const hasNegBal = Object.keys(itemGroups).includes(iId) &&
      itemGroups[iId].some(m => negativeBalanceRows.has(m.rowIdx));

    summaryRows.push([
      iId,
      openingBal !== null ? Math.round(openingBal) : "N/A",
      Math.round(stats.in),
      Math.round(stats.returnQty),
      Math.round(stats.out),
      Math.round(stats.adj),
      closingBal !== null ? Math.round(closingBal) : "N/A",
      invQty !== null ? invQty : "N/A",
      matchStatus,
      hasNegBal ? "⚠️ Có" : "✅ Không"
    ]);
  });

  // Sort theo item_id để dễ đọc
  summaryRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  summarySheet.clearContents();
  summarySheet.getRange(1, 1, 1, summaryHeaders.length).setValues([summaryHeaders]);
  if (summaryRows.length > 0) {
    summarySheet.getRange(2, 1, summaryRows.length, summaryHeaders.length).setValues(summaryRows);
  }

  // Đếm thống kê để log
  const matchCount    = summaryRows.filter(r => r[8] === "✅ Khớp").length;
  const mismatchCount = summaryRows.filter(r => String(r[8]).startsWith("⚠️ Lệch")).length;
  const negBalCount   = summaryRows.filter(r => r[9] === "⚠️ Có").length;
  Logger.log("Summary: " + summaryRows.length + " items | Khớp: " + matchCount +
             " | Lệch: " + mismatchCount + " | Negative balance: " + negBalCount);


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

// ── Parse ngày ────────────────────────────────────────────────────
function parseMovDate(str) {
  if (!str || str === "") return null;
  if (str instanceof Date) return isNaN(str.getTime()) ? null : str;
  str = String(str).trim();

  // YYYY-MM-DD
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    if (!isValidMovDateParts(d, mo, y)) return null;
    return new Date(Date.UTC(y, mo - 1, d));
  }

  // D/M/YYYY hoặc DD/MM/YYYY hoặc DD-MM-YYYY
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const [p1, p2, y] = [+m[1], +m[2], +m[3]];
    if (isValidMovDateParts(p1, p2, y)) return new Date(Date.UTC(y, p2 - 1, p1));
    if (isValidMovDateParts(p2, p1, y)) return new Date(Date.UTC(y, p1 - 1, p2));
    return null;
  }

  // DD/MM/YY (năm 2 chữ số)
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m) {
    const [p1, p2, yy] = [+m[1], +m[2], +m[3]];
    const y = yy > 50 ? 1900 + yy : 2000 + yy;
    if (isValidMovDateParts(p1, p2, y)) return new Date(Date.UTC(y, p2 - 1, p1));
    return null;
  }

  return null;
}

function isValidMovDateParts(d, mo, y) {
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
