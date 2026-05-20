/**
 * ============================================================
 * SALES DATA CLEANING — Google Apps Script
 *  LINK: https://docs.google.com/spreadsheets/d/1GQ6v5nv4jTARKb0sTptBtzjs4ps1d18LxxYCkHPZv0U/edit?pli=1&gid=1806332676#gid=1806332676
 * ============================================================
 *
 * MỤC ĐÍCH: Đọc dữ liệu bẩn từ Sheet1, làm sạch, ghi ra 2 sheet mới:
 *   - Sales_Clean  : dữ liệu đã xử lý, sẵn sàng phân tích
 *   - Cleaning_Log : nhật ký ghi lại mọi thay đổi đã thực hiện
 *
 * CÁCH CHẠY:
 *   1. Google Sheets → File → Import → upload sales_dirty.csv vào Sheet1
 *   2. Extensions → Apps Script → paste toàn bộ file này
 *   3. Chọn function "runSalesCleaning" → nhấn Run
 *
 * CẤU TRÚC FILE (đọc theo thứ tự từ trên xuống):
 *   1. runSalesCleaning()    ← ENTRY POINT: hàm bạn nhấn Run
 *   2. analyzeSalesData()    ← CHẨN ĐOÁN: đếm lỗi trước khi xử lý
 *   3. cleanSalesData()      ← LÀM SẠCH: xử lý từng dòng, ghi log
 *   4. parseViDate()         ← HELPER: parse ngày kiểu Việt Nam
 *   5. isValidParts()        ← HELPER: kiểm tra ngày/tháng/năm hợp lệ
 *   6. isValidDate()         ← HELPER: kiểm tra Date object hợp lệ
 *   7. normalizeRegion()     ← HELPER: chuẩn hoá tên tỉnh/thành
 *   8. toTitleCase()         ← HELPER: viết hoa chữ đầu mỗi từ (tiếng Việt)
 *   9. getOrCreateSheet()    ← HELPER: tạo sheet mới nếu chưa tồn tại
 * ============================================================
 */


// ╔══════════════════════════════════════════════════════════════╗
// ║  1. ENTRY POINT — Hàm duy nhất bạn cần nhấn Run            ║
// ╚══════════════════════════════════════════════════════════════╝

function runSalesCleaning() {

  // SpreadsheetApp.getActiveSpreadsheet() = lấy file Google Sheets đang mở
  // Biến "ss" (spreadsheet) đại diện cho toàn bộ file, chứa nhiều sheet bên trong
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Tìm sheet tên "Sheet1" — đây là sheet chứa dữ liệu gốc sau khi import CSV
  // Nếu không tìm thấy tên "Sheet1", lấy sheet đầu tiên (getSheets()[0]) làm fallback
  const rawSheet = ss.getSheetByName("Sheet1") || ss.getSheets()[0];

  // Logger.log() = in ra console của Apps Script (xem ở View → Logs)
  // Dùng để theo dõi tiến trình khi script đang chạy
  Logger.log("=== BẮT ĐẦU LÀM SẠCH SALES DATA ===");

  // Gọi hàm phân tích để biết dữ liệu đang có bao nhiêu vấn đề
  // JSON.stringify(..., null, 2) = in object ra dạng text đẹp, thụt lề 2 dấu cách
  const result = analyzeSalesData(rawSheet);
  Logger.log("--- Chẩn đoán ---\n" + JSON.stringify(result.diagnosis, null, 2));

  // Xóa sheet cũ trước khi tạo lại — tránh phải xóa tay mỗi lần chạy lại
  // deleteSheetIfExists() kiểm tra tồn tại trước khi xóa, không báo lỗi nếu chưa có
  // Lý do xóa hẳn thay vì clearContents(): xóa luôn cả filter, format, frozen row cũ
  // → sheet mới tạo ra luôn sạch 100%, không bị dính cài đặt từ lần chạy trước
  deleteSheetIfExists(ss, "Sales_Clean");
  deleteSheetIfExists(ss, "Cleaning_Log");

  // Tạo lại 2 sheet mới hoàn toàn sạch
  const cleanSheet = getOrCreateSheet(ss, "Sales_Clean");
  const logSheet   = getOrCreateSheet(ss, "Cleaning_Log");

  // Gọi hàm làm sạch chính — truyền vào 3 sheet: gốc, kết quả, log
  cleanSalesData(rawSheet, cleanSheet, logSheet);

  Logger.log("✅ Hoàn tất. Xem sheet Sales_Clean và Cleaning_Log.");

  // Hiện popup thông báo cho người dùng biết đã xong
  SpreadsheetApp.getUi().alert("✅ Làm sạch xong!\nXem sheet: Sales_Clean và Cleaning_Log");
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  2. CHẨN ĐOÁN — Đọc và đếm các loại vấn đề trong dữ liệu  ║
// ║  Chạy TRƯỚC khi làm sạch để hiểu quy mô vấn đề             ║
// ╚══════════════════════════════════════════════════════════════╝

function analyzeSalesData(sheet) {

  // Giới hạn đúng 10 cột dữ liệu — tránh lấy cả cột ghi chú người dùng thêm vào bên phải
  // Đồng nhất với cách đọc trong cleanSalesData
  const NUM_DATA_COLS = 10;
  const data = sheet.getRange(1, 1, sheet.getLastRow(), NUM_DATA_COLS).getValues();

  // data[0] = mảng hàng đầu tiên = tên các cột (header row)
  // Ví dụ: ["order_id", "date", "customer_id", "product", "amount", ...]
  const headers = data[0];

  // data.slice(1) = bỏ hàng đầu (header), lấy tất cả hàng còn lại = dữ liệu thực
  const rows = data.slice(1);

  // Tạo object "colIdx" để tra cứu vị trí cột theo tên
  // Thay vì viết cứng data[i][4] (cột thứ 5), ta viết data[i][colIdx["amount"]]
  // → code dễ đọc hơn và không bị sai nếu thứ tự cột thay đổi
  const colIdx = {};
  // forEach((h, i) → h = tên cột, i = vị trí số
  // Kết quả: colIdx = { "order_id": 0, "date": 1, "customer_id": 2, ... }
  headers.forEach((h, i) => colIdx[h] = i);

  // Khởi tạo các biến đếm
  let nullCount    = {};  // object đếm số null theo từng cột
  let regionSet    = new Set();  // Set = tập hợp không trùng lặp, thu thập tất cả giá trị region
  let dateFormats  = new Set();  // tập hợp các format ngày khác nhau gặp phải
  let negAmounts   = 0;          // đếm số đơn có amount âm (không phải returned)
  let duplicateIds = new Set();  // tập hợp các order_id bị trùng
  let seenIds      = new Set();  // dùng để phát hiện duplicate: "đã thấy id này chưa?"

  // Khởi tạo bộ đếm null cho mỗi cột = 0
  headers.forEach(h => nullCount[h] = 0);

  // Duyệt qua từng hàng dữ liệu để đếm các vấn đề
  rows.forEach(row => {

    // ── Đếm giá trị null/rỗng theo từng cột ──────────────────
    headers.forEach((h, i) => {
      // Kiểm tra 3 trường hợp "rỗng" khác nhau trong JS
      if (row[i] === "" || row[i] === null || row[i] === undefined) {
        nullCount[h]++;  // tăng bộ đếm của cột h lên 1
      }
    });

    // ── Thu thập tất cả giá trị region để xem có bao nhiêu dạng ──
    const region = row[colIdx["region"]];
    if (region) regionSet.add(String(region).trim());
    // Set.add() tự loại bỏ trùng lặp → cuối cùng biết có bao nhiêu cách viết khác nhau

    // ── Đếm amount âm bất thường ──────────────────────────────
    const amount = parseFloat(row[colIdx["amount"]]);  // chuyển về số thực
    const status = String(row[colIdx["status"]]).toLowerCase();
    // Amount âm chỉ hợp lệ khi status = "returned" (đơn hoàn hàng)
    // Nếu âm mà không phải returned → lỗi dữ liệu
    if (!isNaN(amount) && amount < 0 && status !== "returned") negAmounts++;

    // ── Nhận diện format ngày bằng Regex ──────────────────────
    const dateVal = row[colIdx["date"]];
    if (dateVal) {
      const ds = String(dateVal);
      // ^ = bắt đầu chuỗi, $ = kết thúc chuỗi
      // \d{2} = đúng 2 chữ số, \d{4} = đúng 4 chữ số
      if      (/^\d{2}\/\d{2}\/\d{4}$/.test(ds)) dateFormats.add("DD/MM/YYYY");
      else if (/^\d{4}-\d{2}-\d{2}$/.test(ds))   dateFormats.add("YYYY-MM-DD");
      else if (/^\d{2}-\d{2}-\d{4}$/.test(ds))   dateFormats.add("DD-MM-YYYY");
      else if (/^\d{2}\/\d{2}\/\d{2}$/.test(ds)) dateFormats.add("DD/MM/YY");
      else dateFormats.add("other: " + ds);  // format lạ chưa biết → ghi lại để xem
    }

    // ── Phát hiện duplicate order_id ──────────────────────────
    const orderId = row[colIdx["order_id"]];
    if (seenIds.has(orderId)) {
      // Đã thấy id này rồi → đây là duplicate
      duplicateIds.add(orderId);
    } else {
      // Chưa thấy → ghi nhớ lần đầu tiên
      seenIds.add(orderId);
    }
  });

  // Trả về object chứa kết quả chẩn đoán để in ra log
  return {
    diagnosis: {
      totalRows:       rows.length,
      missingValues:   nullCount,           // VD: { customer_id: 12, region: 8, ... }
      uniqueRegions:   [...regionSet].sort(), // [...set] = chuyển Set thành Array để sort
      dateFormats:     [...dateFormats],
      negativeAmounts: negAmounts,
      duplicateCount:  duplicateIds.size,   // .size = số phần tử trong Set
    }
  };
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  3. LÀM SẠCH CHÍNH — Xử lý từng dòng, ghi kết quả và log  ║
// ╚══════════════════════════════════════════════════════════════╝

function cleanSalesData(rawSheet, cleanSheet, logSheet) {

  // ── Đọc đúng vùng dữ liệu thực — không lấy cột ghi chú bên phải ────
  // getDataRange() lấy toàn bộ vùng có dữ liệu, kể cả cột ghi chú người dùng thêm vào
  // → dùng getRange(1, 1, lastRow, NUM_DATA_COLS) để chỉ lấy đúng 10 cột dữ liệu
  // NUM_DATA_COLS = 10 = số cột thực của dataset (order_id đến discount_pct)
  const NUM_DATA_COLS = 10;
  const lastRow = rawSheet.getLastRow();  // số hàng cuối có dữ liệu (bao gồm header)
  const data    = rawSheet.getRange(1, 1, lastRow, NUM_DATA_COLS).getValues();
  // getRange(startRow, startCol, numRows, numCols):
  //   startRow=1, startCol=1 → bắt đầu từ A1
  //   numRows=lastRow        → lấy đến hàng cuối cùng có dữ liệu
  //   numCols=NUM_DATA_COLS  → chỉ lấy 10 cột, bỏ qua cột K trở đi

  const headers = data[0];        // hàng header
  const rows    = data.slice(1);  // các hàng dữ liệu, bỏ header

  // Tạo bảng tra cứu vị trí cột (tương tự hàm analyze ở trên)
  const colIdx = {};
  headers.forEach((h, i) => colIdx[h] = i);

  // ── Chuẩn bị header cho sheet kết quả ───────────────────────
  // headers = 10 cột gốc (A–J): order_id → discount_pct
  // extraCols = 4 cột tính toán mới, đặt ngay sát sau cột J
  // Kết quả: cột K=month, L=quarter, M=amount_after_discount, N=clean_region
  const extraCols  = ["month", "quarter", "amount_after_discount", "clean_region"];
  const allHeaders = [...headers, ...extraCols];
  // [...headers, ...extraCols] = nối 2 mảng thành 1
  // headers có đúng 10 phần tử (nhờ fix getRange ở trên) nên extraCols sẽ bắt đầu từ cột K

  // ── Khởi tạo các mảng kết quả ───────────────────────────────
  const cleanRows = [];  // sẽ chứa các hàng đã làm sạch, ghi vào Sales_Clean

  // logEntries[0] = hàng header của Cleaning_Log
  const logEntries = [["row_original", "field", "old_value", "new_value", "action"]];

  const seenIds = new Set();  // theo dõi order_id đã xử lý để phát hiện duplicate

  // rowNum theo dõi số thứ tự hàng trong sheet gốc (bắt đầu từ 2 vì hàng 1 là header)
  // Dùng để ghi vào log: "lỗi xảy ra ở hàng số mấy trong file gốc"
  let rowNum = 2;

  // ── Duyệt và xử lý từng hàng ────────────────────────────────
  rows.forEach((row) => {

    // Tạo bản sao của hàng để xử lý — KHÔNG sửa trực tiếp vào "row"
    // [...row] = spread array = tạo mảng mới với các giá trị giống hệt
    // Nếu không copy mà sửa thẳng, "data" gốc cũng bị thay đổi theo (reference)
    const r = [...row];

    const orderId = r[colIdx["order_id"]];


    // ════════════════════════════════════════════════════════
    // XỬ LÝ 1: DUPLICATE — Kiểm tra order_id có bị trùng không
    // ════════════════════════════════════════════════════════
    if (seenIds.has(orderId)) {
      // order_id này đã xuất hiện trước đó → đây là dòng trùng → bỏ qua
      logEntries.push([rowNum, "order_id", orderId, "", "DROPPED_DUPLICATE"]);
      // Array.push() = thêm phần tử vào cuối mảng
      // Ghi log: [số hàng, cột bị lỗi, giá trị cũ, giá trị mới (rỗng), loại hành động]
      rowNum++;
      return;  // return trong forEach = "bỏ qua hàng này, sang hàng tiếp theo"
    }
    // Chưa thấy id này → ghi nhớ để kiểm tra các hàng sau
    seenIds.add(orderId);


    // ════════════════════════════════════════════════════════
    // XỬ LÝ 2: DATE — Chuẩn hoá về format YYYY-MM-DD
    // ════════════════════════════════════════════════════════

    // LẤY GIÁ TRỊ NGÀY GỐC
    // Lý do cần kiểm tra instanceof Date:
    //   Khi bạn import CSV, Google Sheets đôi khi tự nhận ra "2024-08-02" là ngày
    //   và lưu nội bộ dưới dạng Date object (không phải string)
    //   → code cần xử lý cả 2 trường hợp
    const rawDateRaw = r[colIdx["date"]];
    const rawDate = rawDateRaw instanceof Date
      ? Utilities.formatDate(rawDateRaw, "UTC", "dd/MM/yyyy")
      // Nếu là Date object → chuyển thành string "DD/MM/YYYY" để parser xử lý đồng nhất
      // "UTC" = múi giờ UTC, tránh bị lệch giờ do timezone của máy chủ Google
      : String(rawDateRaw);
      // Nếu là string → giữ nguyên, chỉ đảm bảo kiểu dữ liệu là string

    // Gọi hàm parseViDate() để parse chuỗi ngày → Date object
    const parsedDate = parseViDate(rawDate);

    if (parsedDate) {
      const dateFormatted = Utilities.formatDate(parsedDate, "UTC", "yyyy-MM-dd");

      if (parsedDate._inferred) {
        // Format được SUY LUẬN: DD/MM thất bại → đọc ngược lại thành MM/DD thành công
        // Ví dụ: "02/22/2024" → không thể là ngày 02 tháng 22 → suy ra tháng 02, ngày 22
        // Ghi action riêng để người review biết đây là suy luận, cần kiểm tra lại
        logEntries.push([rowNum, "date", rawDate, dateFormatted, "DATE_FORMAT_INFERRED"]);
      } else if (String(rawDate) !== dateFormatted) {
        // Format gốc hợp lệ nhưng khác YYYY-MM-DD → normalize bình thường
        // Ví dụ: "22/02/2024" → "2024-02-22"
        logEntries.push([rowNum, "date", rawDate, dateFormatted, "DATE_NORMALIZED"]);
      }
      // Ghi đè giá trị ngày bằng format chuẩn YYYY-MM-DD (dù suy luận hay normalize)
      r[colIdx["date"]] = dateFormatted;
    } else {
      // Cả DD/MM/YYYY lẫn MM/DD/YYYY đều thất bại → ngày thực sự không đọc được
      // Ví dụ: "32/13/2024" — không có cách đọc nào hợp lệ → drop hàng
      logEntries.push([rowNum, "date", rawDate, "PARSE_ERROR", "DROPPED_ROW"]);
      rowNum++;
      return;
    }


    // ════════════════════════════════════════════════════════
    // XỬ LÝ 3: REGION — Chuẩn hoá tên tỉnh/thành
    // ════════════════════════════════════════════════════════

    // String(...) đảm bảo không bị lỗi nếu giá trị là null/undefined
    // || "" = nếu null/undefined thì dùng chuỗi rỗng thay thế
    // .trim() = xóa khoảng trắng đầu và cuối ("  HN  " → "HN")
    const rawRegion   = String(r[colIdx["region"]] || "").trim();
    const cleanRegion = normalizeRegion(rawRegion);  // tra bảng mapping → tên chuẩn

    // Chỉ ghi log nếu giá trị thực sự thay đổi (tránh log rác)
    if (rawRegion !== cleanRegion) {
      logEntries.push([rowNum, "region", rawRegion, cleanRegion, "REGION_NORMALIZED"]);
    }
    // Lưu ý: cleanRegion sẽ dùng ở phần "derived columns" bên dưới
    // KHÔNG ghi vào r[colIdx["region"]] ở đây — cột region gốc giữ nguyên
    // Giá trị sạch sẽ đi vào cột "clean_region" mới thêm vào cuối


    // ════════════════════════════════════════════════════════
    // XỬ LÝ 4: SALESPERSON — Chuẩn hoá tên nhân viên
    // ════════════════════════════════════════════════════════

    const rawSP = String(r[colIdx["salesperson"]] || "").trim();
    // Ternary operator: nếu rawSP có giá trị → chuẩn hoá, nếu rỗng → "Không xác định"
    const cleanSP = normalizeSalesperson(rawSP);  // tra map trước, title case sau

    if (rawSP !== cleanSP) {
      logEntries.push([rowNum, "salesperson", rawSP, cleanSP, "NAME_NORMALIZED"]);
    }
    // Ghi đè cột salesperson bằng tên đã chuẩn hoá
    r[colIdx["salesperson"]] = cleanSP;


    // ════════════════════════════════════════════════════════
    // XỬ LÝ 5: CROSS-COLUMN VALIDATION — amount × status
    //
    // Kiểm tra sự NHẤT QUÁN giữa 2 cột, không phải từng cột riêng lẻ.
    // Từng cột có thể "hợp lệ" nhưng khi đặt cạnh nhau lại mâu thuẫn.
    //
    // Ma trận 4 tổ hợp:
    //   [A] amount > 0  + completed/pending/cancelled → ✅ Nhất quán, giữ nguyên
    //   [B] amount < 0  + returned                   → ✅ Hợp lệ, FLAG nhẹ để review
    //   [C] amount < 0  + completed/pending/cancelled → ❌ Mâu thuẫn, FLAG để review
    //   [D] amount > 0  + returned                   → ⚠️  Nghi ngờ, FLAG để review
    //
    // Thêm:
    //   [E] amount < 1,000,000 + không returned       → nghi nhầm đơn vị → nhân 1000
    //   [F] Mọi amount → parseFloat + round           → đảm bảo kiểu number
    // ════════════════════════════════════════════════════════

    // parseFloat() + Math.round() → number sạch, không còn "7800.0" hay "-500000" dạng text
    let amount = Math.round(parseFloat(r[colIdx["amount"]]));

    // status về lowercase để so sánh không phân biệt hoa/thường
    // "Returned" == "returned" == "RETURNED" → đều pass
    const status = String(r[colIdx["status"]]).toLowerCase();
    const isReturned = (status === "returned");

    if (!isNaN(amount)) {

      // ── TỔ HỢP [C]: amount ÂM + KHÔNG phải returned → MÂU THUẪN ──────────
      // Đơn completed/pending/cancelled KHÔNG THỂ có doanh thu âm theo logic nghiệp vụ
      // Trước đây: DROP thẳng → mất dữ liệu, không có cơ hội review
      // Bây giờ: GIỮ LẠI + FLAG "AMOUNT_STATUS_CONFLICT"
      //   → người review lọc action này trong Cleaning_Log
      //   → quyết định: sửa status thành "returned"? hay xóa? hay giữ nguyên?
      // Ví dụ: ORD-1033, amount=-4,200,000, status=completed → FLAG
      if (amount < 0 && !isReturned) {
        logEntries.push([rowNum, "amount", amount, amount, "AMOUNT_STATUS_CONFLICT"]);
        // GIỮ NGUYÊN giá trị — không tự sửa vì không biết cột nào sai (amount hay status)
      }

      // ── TỔ HỢP [B]: amount ÂM + returned → Hợp lệ nhưng FLAG nhẹ ──────────
      // Một số hệ thống ghi returned là âm (hoàn tiền = -số tiền)
      // Số khác ghi returned là dương (giá trị hàng hoàn)
      // Convention không thống nhất → FLAG để người review biết
      // Ví dụ: ORD-1034, amount=-9,500,000, status=returned → FLAG nhẹ
      if (amount < 0 && isReturned) {
        logEntries.push([rowNum, "amount", amount, amount, "AMOUNT_NEGATIVE_RETURNED"]);
      }

      // ── TỔ HỢP [D]: amount DƯƠNG + returned → Nghi ngờ ──────────────────
      // Có thể: (1) nhập đúng — hệ thống ghi returned bằng số dương
      //         (2) nhập sai — quên gõ dấu âm
      // Không thể phân biệt mà không hỏi → FLAG để review
      // Ví dụ: amount=9,500,000, status=returned → cần xác nhận convention
      if (amount > 0 && isReturned) {
        logEntries.push([rowNum, "amount", amount, amount, "AMOUNT_POSITIVE_RETURNED"]);
      }

      // ── TỔ HỢP [E]: amount quá nhỏ + không returned → nghi nhầm đơn vị ──
      // Ngưỡng 100,000 VND: dữ liệu lỗi thực tế là string bị parse thành số < 100,000
      // Không dùng ngưỡng 1,000,000 vì sản phẩm hợp lệ (Mouse Wireless × 2 = 900,000) bị nhân nhầm
      // amount < 100,000 chắc chắn là lỗi — không có sản phẩm nào trong dataset < 100,000 VND
      // Ví dụ lỗi: "7.8" → 7 khi parse → × 1000 → 7,000 vẫn sai → cần kiểm tra thêm
      if (amount > 0 && amount < 100000 && !isReturned) {
        const fixedAmount = amount * 1000;
        logEntries.push([rowNum, "amount", amount, fixedAmount, "AMOUNT_UNIT_FIXED"]);
        amount = fixedAmount;  // cập nhật để tính toán bên dưới dùng giá trị đã sửa
      }

      // ── TỔ HỢP [A]: amount DƯƠNG + không returned → Nhất quán ───────────
      // Không cần làm gì, không cần ghi log — đây là trường hợp bình thường
    }

    // ── [F]: Ghi amount đã clean vào hàng ────────────────────────────────
    // Luôn là kiểu number sau Math.round(parseFloat(...))
    // isNaN check: phòng trường hợp ô trống hoặc text không parse được
    r[colIdx["amount"]] = isNaN(amount) ? "" : amount;


    // ════════════════════════════════════════════════════════
    // XỬ LÝ 6: CUSTOMER_ID — Fill null bằng "UNKNOWN"
    // ════════════════════════════════════════════════════════

    // Falsy check: !r[...] bắt cả null, undefined, "", 0
    // Với customer_id, mọi giá trị "falsy" đều coi là thiếu dữ liệu
    if (!r[colIdx["customer_id"]]) {
      r[colIdx["customer_id"]] = "UNKNOWN";
      logEntries.push([rowNum, "customer_id", "", "UNKNOWN", "FILLED_NULL"]);
    }


    // ════════════════════════════════════════════════════════
    // XỬ LÝ 7: DISCOUNT_PCT — Fill null bằng 0
    // ════════════════════════════════════════════════════════

    // Kiểm tra riêng "" và null vì discount_pct = 0 là giá trị hợp lệ
    // Không dùng !r[...] ở đây vì !0 = true → sẽ ghi đè 0 thành 0 không cần thiết
    if (r[colIdx["discount_pct"]] === "" || r[colIdx["discount_pct"]] === null) {
      r[colIdx["discount_pct"]] = 0;
      logEntries.push([rowNum, "discount_pct", "", "0", "FILLED_NULL"]);
    }


    // ════════════════════════════════════════════════════════
    // TÍNH TOÁN — Thêm 4 cột phái sinh (derived columns)
    // ════════════════════════════════════════════════════════

    // discountPct: parseFloat đọc từ r[...] (đã fill 0 ở bước 7 nên không còn null)
    // || 0 = phòng trường hợp NaN
    const discountPct = parseFloat(r[colIdx["discount_pct"]]) || 0;

    // amount lúc này đã là number đã clean (từ bước xử lý 5 ở trên)
    // Nếu amount là NaN (ô rỗng) → dùng 0 để tránh NaN lan sang amountAfterDiscount
    const cleanAmount         = isNaN(amount) ? 0 : amount;
    const amountAfterDiscount = cleanAmount * (1 - discountPct / 100);
    // Ví dụ: amount=10_000_000, discountPct=10
    //   → 10_000_000 * (1 - 0.1) = 9_000_000
    // Ví dụ: amount=7_800_000 (đã nhân 1000), discountPct=0
    //   → 7_800_000 * 1 = 7_800_000

    // r.push() = thêm 4 giá trị vào cuối mảng hàng (ứng với 4 cột extraCols)
    r.push(
      parsedDate.getMonth() + 1,
      // getMonth() trả về 0–11 (JS đánh số từ 0), cộng 1 để ra 1–12
      // Ví dụ: tháng 3 → getMonth() = 2 → +1 = 3 ✓

      Math.ceil((parsedDate.getMonth() + 1) / 3),
      // quarter: chia tháng cho 3, làm tròn lên
      // Tháng 1,2,3 → (1,2,3)/3 → ceil → 1 (Q1)
      // Tháng 4,5,6 → (4,5,6)/3 → ceil → 2 (Q2)
      // Tháng 10,11,12 → (10,11,12)/3 → ceil → 4 (Q4)

      Math.round(amountAfterDiscount),
      // amountAfterDiscount đã tính từ cleanAmount (đã fix đơn vị, đã round)
      // Math.round thêm lần nữa để xử lý số lẻ từ phép nhân discount

      cleanRegion
      // Tên tỉnh/thành đã chuẩn hoá ở bước xử lý 3
    );

    // Hàng đã xử lý xong → đưa vào danh sách kết quả
    cleanRows.push(r);
    rowNum++;  // tăng bộ đếm dòng cho lần lặp tiếp theo
  });


  // ════════════════════════════════════════════════════════
  // GHI KẾT QUẢ — Batch write 1 lần duy nhất (tốt hơn nhiều so với từng ô)
  // ════════════════════════════════════════════════════════

  // Xóa nội dung cũ trong sheet (nếu đã chạy trước đó)
  cleanSheet.clearContents();

  // Ghi hàng header: getRange(row, col, numRows, numCols)
  //   row=1, col=1       → bắt đầu từ ô A1
  //   numRows=1           → 1 hàng
  //   numCols=allHeaders.length → số cột = số phần tử trong allHeaders
  // setValues() nhận mảng 2 chiều → [allHeaders] bọc thêm [] để thành [[header1, header2, ...]]
  cleanSheet.getRange(1, 1, 1, allHeaders.length).setValues([allHeaders]);

  // Ghi các hàng dữ liệu (chỉ ghi nếu có ít nhất 1 hàng sạch)
  if (cleanRows.length > 0) {
    // row=2                    → bắt đầu từ hàng 2 (hàng 1 là header)
    // numRows=cleanRows.length → số hàng = số hàng đã xử lý thành công
    // numCols=allHeaders.length → số cột
    cleanSheet.getRange(2, 1, cleanRows.length, allHeaders.length).setValues(cleanRows);
  }

  // Xóa log cũ và ghi log mới
  logSheet.clearContents();
  // logEntries[0] = header row, logEntries[1..n] = các thay đổi
  logSheet.getRange(1, 1, logEntries.length, logEntries[0].length).setValues(logEntries);

  // In tóm tắt ra console: bao nhiêu hàng sạch, bao nhiêu thay đổi được log
  Logger.log(`✅ Clean rows: ${cleanRows.length} | Log entries: ${logEntries.length - 1}`);
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  4. HELPER: Parse ngày Việt Nam                             ║
// ║  Nhận vào 1 chuỗi ngày → trả về Date object (hoặc null)    ║
// ╚══════════════════════════════════════════════════════════════╝

function parseViDate(str) {

  // Trường hợp đặc biệt: giá trị rỗng/null → trả về null ngay
  if (!str || str === "" || str === "null") return null;

  // Trường hợp Sheets đã tự parse thành Date object (xảy ra khi import CSV)
  // → kiểm tra hợp lệ và trả về thẳng, không cần parse lại
  if (str instanceof Date) {
    return isValidDate(str) ? str : null;
  }

  // Đảm bảo đầu vào là string và loại bỏ khoảng trắng đầu/cuối
  str = String(str).trim();

  // ── Format 1: YYYY-MM-DD (ISO standard) ──────────────────────
  // Regex: ^ bắt đầu, \d{4} 4 chữ số, - dấu gạch, \d{2} 2 chữ số, $ kết thúc
  // match() trả về mảng: m[0]=toàn bộ, m[1]=nhóm 1, m[2]=nhóm 2, m[3]=nhóm 3
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    // Dấu + trước biến = ép kiểu string → number: +"2024" = 2024
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    // [y, mo, d] = destructuring: gán lần lượt y=m[1], mo=m[2], d=m[3]
    if (!isValidParts(d, mo, y)) return null;
    // new Date(y, mo-1, d) tạo Date theo LOCAL timezone của server Google
    // → khi formatDate("UTC") có thể bị lệch 1 ngày do timezone
    // Dùng new Date(Date.UTC(y, mo-1, d)) để tạo Date theo UTC thuần túy
    // → formatDate("UTC") sẽ luôn cho đúng ngày, không phụ thuộc server đặt ở đâu
    return new Date(Date.UTC(y, mo - 1, d));
  }

  // ── Format 2: DD/MM/YYYY hoặc DD-MM-YYYY — thử VN trước, suy luận US sau ───
  // Regex khớp cả "02/22/2024" (Mỹ) lẫn "22/02/2024" (VN) — cùng pattern số/số/số
  m = str.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (m) {
    const p1 = +m[1], p2 = +m[2], y = +m[3];

    // Bước 1 — thử đọc theo chuẩn Việt Nam: p1=ngày, p2=tháng
    // Ví dụ "22/02/2024": ngày=22, tháng=2 → hợp lệ → dùng luôn
    if (isValidParts(p1, p2, y)) {
      return new Date(Date.UTC(y, p2 - 1, p1));  // UTC để tránh lệch ngày do timezone
    }

    // Bước 2 — DD/MM thất bại → suy luận: thử đọc theo chuẩn Mỹ: p1=tháng, p2=ngày
    // Ví dụ "02/22/2024": p1=2 (tháng), p2=22 (ngày)
    //   → isValidParts(ngày=22, tháng=2) hợp lệ → suy ra là MM/DD/YYYY
    // Logic tự nhiên: nếu p2 > 12 thì p2 KHÔNG THỂ là tháng → chắc chắn là ngày
    //   → buộc phải đọc p1 là tháng (MM/DD/YYYY)
    if (isValidParts(p2, p1, y)) {
      const inferredDate = new Date(Date.UTC(y, p1 - 1, p2));  // UTC
      // Đánh dấu để caller ghi log "DATE_FORMAT_INFERRED" thay vì "DATE_NORMALIZED"
      inferredDate._inferred = true;
      return inferredDate;
    }

    // Cả hai cách đọc đều thất bại (VD: "32/13/2024") → thực sự là dữ liệu lỗi
    return null;
  }

  // ── Format 3: DD/MM/YY (năm 2 chữ số) ───────────────────────
  m = str.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (m) {
    const [d, mo] = [+m[1], +m[2]];
    // Quy ước chuyển năm 2 chữ số → 4 chữ số:
    //   > 50 → thế kỷ 20: 99 → 1999, 51 → 1951
    //   ≤ 50 → thế kỷ 21: 24 → 2024, 00 → 2000
    const y = +m[3] > 50 ? 1900 + +m[3] : 2000 + +m[3];
    if (!isValidParts(d, mo, y)) return null;
    return new Date(Date.UTC(y, mo - 1, d));  // UTC để tránh lệch ngày
  }

  // Không khớp format nào → trả về null → hàng sẽ bị drop
  return null;
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  5. HELPER: Validate ngày/tháng/năm có hợp lệ không        ║
// ╚══════════════════════════════════════════════════════════════╝

function isValidParts(d, mo, y) {
  // Kiểm tra từng điều kiện — return false ngay khi phát hiện lỗi (short-circuit)
  if (mo < 1 || mo > 12)     return false;  // tháng phải 1–12
  if (d  < 1 || d  > 31)     return false;  // ngày phải 1–31
  if (y  < 2000 || y > 2100) return false;  // năm trong phạm vi hợp lý cho dự án này

  // Kiểm tra ngày có thực sự tồn tại không
  // Ví dụ: 31/02 có vẻ hợp lệ theo điều kiện trên, nhưng tháng 2 không có ngày 31
  // Kỹ thuật: tạo thử Date → nếu JS điều chỉnh sang ngày khác → ngày gốc không tồn tại
  const test = new Date(y, mo - 1, d);
  return (
    test.getFullYear() === y   &&  // năm không bị thay đổi
    test.getMonth()    === mo - 1 &&  // tháng không bị thay đổi
    test.getDate()     === d       // ngày không bị thay đổi
  );
  // Ví dụ 31/02/2024:
  //   new Date(2024, 1, 31) → JS tự chuyển thành 02/03/2024 (tràn sang tháng 3)
  //   test.getMonth() = 2 ≠ 1 (mo-1) → return false ✓
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  6. HELPER: Kiểm tra Date object có hợp lệ không           ║
// ╚══════════════════════════════════════════════════════════════╝

function isValidDate(d) {
  // Điều kiện 1: phải là Date object (không phải string hay số)
  // Điều kiện 2: getTime() không trả về NaN
  //   new Date("abc") → Invalid Date → getTime() = NaN
  return d instanceof Date && !isNaN(d.getTime());
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  7. HELPER: Chuẩn hoá tên tỉnh/thành                       ║
// ║  Nhận vào chuỗi bẩn → trả về tên chuẩn                     ║
// ╚══════════════════════════════════════════════════════════════╝

function normalizeRegion(val) {

  // Bảng mapping: key = các cách viết có thể gặp, value = tên chuẩn
  // Toàn bộ logic nằm ở đây — thêm trường hợp mới chỉ cần thêm 1 dòng
  const map = {
    // Hà Nội — 3 cách viết
    "hn":      "Hà Nội",
    "ha noi":  "Hà Nội",
    "hà nội":  "Hà Nội",

    // Hồ Chí Minh — 5 cách viết
    "hcm":          "Hồ Chí Minh",
    "ho chi minh":  "Hồ Chí Minh",
    "sg":           "Hồ Chí Minh",
    "sài gòn":      "Hồ Chí Minh",
    "sai gon":      "Hồ Chí Minh",

    // Đà Nẵng — 3 cách viết
    "da nang":  "Đà Nẵng",
    "dn":       "Đà Nẵng",
    "đà nẵng":  "Đà Nẵng",

    // Hải Phòng — 3 cách viết
    "hp":          "Hải Phòng",
    "hai phong":   "Hải Phòng",
    "hải phòng":   "Hải Phòng",
  };

  // Đưa về lowercase + trim để tra cứu bình đẳng
  // "HN" → "hn", "  Hà Nội  " → "hà nội" → đều tìm thấy trong map
  const key = val.toLowerCase().trim();

  // map[key] = tra cứu → nếu có → trả về tên chuẩn
  // || = nếu không có trong map: giữ nguyên val (có thể là tên chuẩn rồi)
  //   hoặc nếu val rỗng → "Không xác định"
  return map[key] || (val || "Không xác định");
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  8. HELPER: Chuẩn hoá tên nhân viên                         ║
// ║  Bước 1: tra bảng map (tên không dấu → tên chuẩn có dấu)   ║
// ║  Bước 2: nếu không có trong map → title case thông thường   ║
// ╚══════════════════════════════════════════════════════════════╝

// Bảng mapping tên nhân viên — key: lowercase, value: tên chuẩn có dấu
// Cần vì toTitleCase() không thể tự thêm dấu tiếng Việt
const SALESPERSON_MAP = {
  "le minh cuong":  "Lê Minh Cường",   // không dấu → có dấu
  "le minh cường":  "Lê Minh Cường",   // thiếu dấu một số chỗ
  "nguyen van an":  "Nguyễn Văn An",
  "tran thi binh":  "Trần Thị Bình",
  "pham thi dung":  "Phạm Thị Dung",
  "hoang van em":   "Hoàng Văn Em",
};

function normalizeSalesperson(val) {
  if (!val || val.trim() === "") return "Không xác định";

  // Bước 1: tra map theo lowercase → bắt được "LE MINH CUONG", "le minh cuong", "Le Minh Cuong"
  const key = val.trim().toLowerCase();
  if (SALESPERSON_MAP[key]) return SALESPERSON_MAP[key];

  // Bước 2: không có trong map → title case thông thường
  return toTitleCase(val);
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  9. HELPER: Viết hoa chữ đầu mỗi từ (hỗ trợ tiếng Việt)   ║
// ╚══════════════════════════════════════════════════════════════╝

function toTitleCase(str) {
  // Bước 1: trim() → xóa khoảng trắng đầu/cuối ("Nguyễn Văn An " → "Nguyễn Văn An")
  // Bước 2: toLowerCase() → viết thường toàn bộ ("TRẦN THỊ BÌNH" → "trần thị bình")
  // Bước 3: split(/\s+/) → tách thành mảng các từ theo khoảng trắng
  //   \s+ = 1 hoặc nhiều ký tự khoảng trắng (space, tab)
  //   "trần  thị  bình" (double space) → ["trần", "thị", "bình"] (vẫn đúng)
  // Bước 4: .map() → duyệt qua từng từ, viết hoa ký tự đầu tiên
  //   word.charAt(0).toUpperCase() = lấy ký tự đầu và viết hoa
  //   word.slice(1) = phần còn lại của từ (giữ nguyên lowercase)
  //   Ví dụ: "trần" → "T" + "rần" = "Trần"
  //   Ví dụ: "thị"  → "T" + "hị"  = "Thị"  ← ký tự Unicode "ị" được giữ đúng
  // Bước 5: .join(" ") → nối lại thành chuỗi, ngăn cách bằng 1 dấu cách

  return str.trim().toLowerCase()
    .split(/\s+/)
    .map(word => word.length === 0
      ? word  // bỏ qua chuỗi rỗng (phòng trường hợp split tạo ra phần tử rỗng)
      : word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

  // TẠI SAO KHÔNG DÙNG: str.replace(/\b\w/g, c => c.toUpperCase())
  //   \b = word boundary (ranh giới từ) trong JS chỉ nhận ký tự ASCII [a-zA-Z0-9_]
  //   \w = word character, cũng chỉ là ASCII
  //   → "trần" : \b khớp trước "t", nhưng "r","ầ","n" không được xử lý
  //   → "thị"  : \b không nhận ra "ị" là ký tự chữ → viết hoa sai/thiếu
  //   Giải pháp tách từ thủ công ở trên xử lý đúng mọi Unicode ✓
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  9. HELPER: Xóa sheet nếu tồn tại                           ║
// ║  Dùng trước mỗi lần chạy để reset hoàn toàn, không xóa tay ║
// ╚══════════════════════════════════════════════════════════════╝

function deleteSheetIfExists(ss, name) {
  const sheet = ss.getSheetByName(name);

  if (!sheet) {
    // Sheet không tồn tại → không làm gì, không báo lỗi
    // Trường hợp này xảy ra lần đầu tiên chạy script
    return;
  }

  // Google Sheets không cho xóa sheet duy nhất còn lại trong file
  // → kiểm tra số sheet hiện có trước khi xóa
  if (ss.getSheets().length === 1) {
    // Chỉ còn 1 sheet → không xóa được, xóa nội dung thay thế
    // Trường hợp này hiếm xảy ra nhưng cần handle để tránh lỗi crash
    sheet.clearContents();
    return;
  }

  // Xóa hẳn sheet — sạch hoàn toàn: nội dung, format, filter, frozen rows
  // Khác với clearContents() chỉ xóa dữ liệu nhưng giữ lại format cũ
  ss.deleteSheet(sheet);
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  10. HELPER: Lấy sheet theo tên, tạo mới nếu chưa tồn tại  ║
// ╚══════════════════════════════════════════════════════════════╝

function getOrCreateSheet(ss, name) {
  let sheet = ss.getSheetByName(name);

  if (!sheet) {
    // Chưa có sheet tên này → tạo mới
    // Sau deleteSheetIfExists() ở trên, hàm này luôn tạo sheet mới hoàn toàn
    sheet = ss.insertSheet(name);
  }

  return sheet;
}
