/**
 * ============================================================
 * PROJECT 04 — SUPPLY CHAIN: SUPPLIERS CLEANING
 * ============================================================
 * CÁCH DÙNG:
 *   1. Tạo Google Sheets mới → File → Import → suppliers_dirty.csv
 *      Đặt tên sheet là "suppliers_dirty"
 *   2. Extensions → Apps Script → paste toàn bộ file này
 *   3. Chọn function runSuppliersCleaning() → Run
 *
 * OUTPUT 3 SHEET:
 *   suppliers_clean : dữ liệu sạch — analyst dùng để phân tích
 *   Cleaning_Log    : audit trail — ghi lại mọi thay đổi
 *   Flagged         : dòng cần người review xem xét thêm
 *
 * CÁC KỸ THUẬT MỚI TRONG PROJECT NÀY:
 *   - payment_terms: keyword matching thay vì bảng mapping cứng
 *     → "30 ngày"/"NET30"/"30 days" đều chứa "30" → NET30
 *   - is_active: Sheets tự parse TRUE/FALSE thành boolean khi import
 *     → phải dùng typeof để phân biệt boolean/number/string
 *   - Fuzzy deduplication: phát hiện tên NCC gần giống nhau
 *     → bỏ stop words → normalize → so sánh chuỗi đã chuẩn hoá
 * ============================================================
 */


// ── HẰNG SỐ TOÀN CỤC ─────────────────────────────────────────────
// Số cột thực của suppliers dataset: supplier_id → is_active = 7 cột
// Dùng khi gọi getRange để tránh đọc thêm cột ghi chú bên phải
const SUP_DATA_COLS = 7;


// ╔══════════════════════════════════════════════════════════════╗
// ║  1. ENTRY POINT — Hàm duy nhất bạn cần nhấn Run            ║
// ╚══════════════════════════════════════════════════════════════╝

function runSuppliersCleaning() {

  // Lấy Google Sheets file đang mở
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Tìm sheet "suppliers_dirty" — sheet chứa data gốc sau khi import CSV
  // || ss.getSheets()[0] = fallback: nếu không có tên đó, lấy sheet đầu tiên
  const rawSheet = ss.getSheetByName("suppliers_dirty") || ss.getSheets()[0];

  Logger.log("=== BẮT ĐẦU LÀM SẠCH SUPPLIERS ===");

  // Xóa sheet kết quả cũ trước khi tạo lại
  // Lý do: tránh phải xóa tay mỗi khi chạy lại
  // deleteSheetIfExists() an toàn hơn deleteSheet() vì không báo lỗi nếu sheet chưa có
  deleteSheetIfExists(ss, "suppliers_clean");
  deleteSheetIfExists(ss, "Cleaning_Log");
  deleteSheetIfExists(ss, "Flagged");

  // Tạo 3 sheet output mới hoàn toàn sạch
  const cleanSheet = getOrCreateSheet(ss, "suppliers_clean");
  const logSheet   = getOrCreateSheet(ss, "Cleaning_Log");
  const flagSheet  = getOrCreateSheet(ss, "Flagged");

  // Chạy hàm làm sạch chính, truyền vào các sheet để ghi kết quả
  cleanSuppliersData(rawSheet, cleanSheet, logSheet, flagSheet);

  // Thông báo hoàn tất cho người dùng
  SpreadsheetApp.getUi().alert("✅ Suppliers cleaning xong!\nXem: suppliers_clean, Cleaning_Log, Flagged");
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  2. HÀM LÀM SẠCH CHÍNH — 7 bước xử lý                     ║
// ╚══════════════════════════════════════════════════════════════╝

function cleanSuppliersData(rawSheet, cleanSheet, logSheet, flagSheet) {

  // ── ĐỌC DỮ LIỆU GỐC ─────────────────────────────────────────
  // getRange(startRow, startCol, numRows, numCols):
  //   startRow=1, startCol=1 → bắt đầu từ ô A1
  //   getLastRow() → số hàng cuối có dữ liệu (tự động, không cần chỉ định cứng)
  //   SUP_DATA_COLS → chỉ lấy 7 cột thực, bỏ qua cột ghi chú thừa bên phải
  const data    = rawSheet.getRange(1, 1, rawSheet.getLastRow(), SUP_DATA_COLS).getValues();
  const headers = data[0];        // hàng 0 = header (tên cột)
  const rows    = data.slice(1);  // hàng 1 trở đi = dữ liệu, bỏ header

  // Bảng tra cứu vị trí cột theo tên
  // Thay vì viết cứng r[0], r[1]... → dùng r[colIdx["supplier_id"]]
  // Dễ đọc hơn và không bị sai nếu thứ tự cột thay đổi
  const colIdx = {};
  headers.forEach((h, i) => colIdx[h] = i);
  // Kết quả: { "supplier_id": 0, "supplier_name": 1, "email": 2, ... }

  // ── ĐỊNH NGHĨA HEADER CHO 3 SHEET OUTPUT ─────────────────────
  const logHeaders  = ["row_original", "field", "old_value", "new_value", "action"];
  // row_original: số hàng trong file gốc (bắt đầu từ 2, hàng 1 là header)
  // field: tên cột bị thay đổi
  // old_value / new_value: giá trị trước và sau
  // action: loại hành động (NAME_NORMALIZED, EMAIL_DIACRITIC_REMOVED, ...)

  const flagHeaders = ["supplier_id", "supplier_name", "flag_type", "field", "value", "note"];
  // flag_type: loại vấn đề (FUZZY_DUPLICATE, EMAIL_INVALID, PHONE_INVALID, ...)
  // note: giải thích cho người review

  // ── KHỞI TẠO MẢNG KẾT QUẢ ───────────────────────────────────
  const cleanRows  = [];              // hàng đã làm sạch → ghi vào suppliers_clean
  const logEntries = [logHeaders];    // logEntries[0] = header, từ [1] là data
  const flagRows   = [];              // dòng cần review → ghi vào Flagged
  const seenIds    = new Set();       // Set lưu supplier_id đã thấy → phát hiện duplicate
  let   rowNum     = 2;
  // rowNum bắt đầu từ 2 vì:
  //   - hàng 1 trong Sheets là header
  //   - hàng dữ liệu đầu tiên = hàng 2
  // Dùng để ghi vào log: "lỗi ở hàng X trong file gốc"


  // ══════════════════════════════════════════════════════════════
  // VÒNG LẶP CHÍNH — xử lý từng hàng một
  // rows.forEach() duyệt qua mảng rows, mỗi lần gọi callback với 1 hàng
  // ══════════════════════════════════════════════════════════════

  rows.forEach((row) => {

    // Tạo bản sao hàng để sửa — KHÔNG sửa trực tiếp "row"
    // [...row] = spread operator: tạo mảng mới với giá trị giống hệt
    // Nếu sửa thẳng "row" → biến "data" gốc cũng bị thay đổi (JavaScript dùng reference)
    const r     = [...row];
    const supId = r[colIdx["supplier_id"]];  // lấy supplier_id từ cột đúng vị trí


    // ════════════════════════════════════════════════════════════
    // BƯỚC 1: DUPLICATE — kiểm tra supplier_id đã thấy chưa
    //
    // Set.has(id): kiểm tra xem id có trong tập hợp không → O(1), rất nhanh
    // Nếu đã thấy → dòng trùng → bỏ qua (return = thoát khỏi callback này)
    // Nếu chưa → ghi nhớ vào Set để kiểm tra các dòng sau
    // ════════════════════════════════════════════════════════════
    if (seenIds.has(supId)) {
      // Ghi log trước khi bỏ qua — để biết dòng nào bị drop và tại sao
      logEntries.push([rowNum, "supplier_id", supId, "", "DROPPED_DUPLICATE"]);
      rowNum++;
      return;  // return trong forEach = "bỏ qua hàng này, sang hàng tiếp theo"
    }
    seenIds.add(supId);  // chưa thấy → ghi nhớ


    // ════════════════════════════════════════════════════════════
    // BƯỚC 2: SUPPLIER_NAME — chuẩn hoá tên công ty
    //
    // Xử lý 2 vấn đề:
    //   1. Viết hoa/thường không nhất quán (ALL CAPS, lowercase)
    //   2. Từ viết tắt: "Cty" → "Công Ty", "TNHH"/"Cp" → giữ ALL CAPS
    //
    // Fuzzy duplicate (tên gần giống nhau) được xử lý RIÊNG ở Bước 7
    // sau vòng lặp — vì cần toàn bộ danh sách tên mới so sánh được
    // ════════════════════════════════════════════════════════════
    const rawName = String(r[colIdx["supplier_name"]] || "").trim();
    // String(...) → đảm bảo không lỗi nếu giá trị là null/undefined
    // || "" → nếu null thì dùng "" thay thế
    // .trim() → xóa khoảng trắng đầu/cuối

    const cleanName = rawName ? toTitleCase(rawName) : "Không Xác Định";
    // Ternary: nếu rawName có giá trị → xử lý, nếu rỗng → "Không Xác Định"

    if (rawName !== cleanName) {
      // Chỉ ghi log khi thực sự có thay đổi — tránh log rác
      logEntries.push([rowNum, "supplier_name", rawName, cleanName, "NAME_NORMALIZED"]);
    }
    r[colIdx["supplier_name"]] = cleanName;  // ghi đè giá trị đã clean vào bản sao


    // ════════════════════════════════════════════════════════════
    // BƯỚC 3: EMAIL — 3 tình huống xử lý
    //
    // [A] Có @ + có dấu tiếng Việt phần local → bỏ dấu
    //     VD: "cpđiệntử@gmail.com" → "cpdientu@gmail.com"
    //     Phần domain (@gmail.com) giữ nguyên, chỉ bỏ dấu phần trước @
    //
    // [B] Thiếu @ + nhận ra domain → chèn @ + bỏ dấu local
    //     VD: "cpdientugmail.com" → "cpdientu@gmail.com"
    //     Domain nhận biết: outlook.com, company.vn, gmail.com, yahoo.com
    //
    // [C] Thiếu @ + không nhận ra domain → FLAG, không tự sửa
    //     Vì không biết đúng phải sửa thế nào → sửa sai còn tệ hơn để nguyên
    // ════════════════════════════════════════════════════════════
    const rawEmail = String(r[colIdx["email"]] || "").trim();
    let   cleanEmail = rawEmail;  // mặc định giữ nguyên

    if (!rawEmail) {
      // Email rỗng/null → ghi log, không làm gì thêm
      logEntries.push([rowNum, "email", "", "", "EMAIL_NULL"]);

    } else if (rawEmail.includes("@")) {
      // [A] Có @ → tách local và domain, bỏ dấu phần local
      const atIdx      = rawEmail.indexOf("@");  // vị trí dấu @
      const local      = rawEmail.substring(0, atIdx);   // phần trước @: "cpđiệntử"
      const domain     = rawEmail.substring(atIdx);      // @ + domain: "@gmail.com"
      const localClean = removeDiacritics(local);         // bỏ dấu: "cpđiệntử" → "cpdientu"

      if (local !== localClean) {
        // Có sự khác biệt → đã bỏ được dấu → ghi log
        cleanEmail = localClean + domain;  // "cpdientu" + "@gmail.com"
        logEntries.push([rowNum, "email", rawEmail, cleanEmail, "EMAIL_DIACRITIC_REMOVED"]);
      }
      // Nếu local === localClean → không có dấu → giữ nguyên, không log

    } else {
      // [B] + [C] Thiếu @ → thử tìm domain
      const fixed = fixMissingAt(rawEmail);
      // fixMissingAt() trả về email đã sửa nếu nhận ra domain, null nếu không

      if (fixed) {
        // [B] Nhận ra domain → đã sửa
        cleanEmail = fixed;
        logEntries.push([rowNum, "email", rawEmail, cleanEmail, "EMAIL_AT_INSERTED"]);
      } else {
        // [C] Không nhận ra → flag để review, giữ nguyên giá trị
        logEntries.push([rowNum, "email", rawEmail, "", "EMAIL_BROKEN"]);
        flagRows.push([supId, cleanName, "EMAIL_INVALID", "email", rawEmail,
          "Email không hợp lệ — cần xác nhận"]);
      }
    }
    r[colIdx["email"]] = cleanEmail;


    // ════════════════════════════════════════════════════════════
    // BƯỚC 4: PHONE — chuẩn hoá về 10 số chuẩn Việt Nam
    //
    // Rule tự sửa (rõ ràng 100%, không flag):
    //   +84xxxxxxxxx (12 ký tự) → bỏ +84, thêm 0 → 0xxxxxxxxx
    //   84xxxxxxxxx  (11 ký tự) → bỏ 84,  thêm 0 → 0xxxxxxxxx
    //   [35789]xxxxxxxx (9 ký tự) → thêm 0 → 0[35789]xxxxxxxx
    //     Lý do: đầu số di động VN bắt đầu 3,5,7,8,9
    //     9 số bắt đầu các đầu này → chắc chắn thiếu số 0
    //
    // Flag (không chắc, không tự sửa):
    //   Sau tất cả bước trên vẫn không đúng format 0[35789]xxxxxxxx
    // ════════════════════════════════════════════════════════════
    const rawPhone   = String(r[colIdx["phone"]] || "").trim();
    let   cleanPhone = rawPhone.replace(/[\s\-\.]/g, "");
    // Regex /[\s\-\.]/g: xóa tất cả khoảng trắng, dấu gạch, dấu chấm
    // \s = whitespace, \- = gạch ngang, \. = dấu chấm
    // g = global flag: thay tất cả (không chỉ lần đầu)

    if (cleanPhone.startsWith("+84") && cleanPhone.length === 12) {
      // "+84" + 9 số = 12 ký tự → bỏ "+84", thêm "0"
      cleanPhone = "0" + cleanPhone.substring(3);
      // substring(3): lấy từ vị trí 3 trở đi (bỏ 3 ký tự "+84")

    } else if (cleanPhone.startsWith("84") && cleanPhone.length === 11) {
      // "84" + 9 số = 11 ký tự → bỏ "84", thêm "0"
      cleanPhone = "0" + cleanPhone.substring(2);

    } else if (/^[35789]\d{8}$/.test(cleanPhone)) {
      // Regex ^[35789]\d{8}$:
      //   ^ = bắt đầu chuỗi
      //   [35789] = 1 ký tự trong tập {3,5,7,8,9}
      //   \d{8} = đúng 8 chữ số tiếp theo
      //   $ = kết thúc chuỗi
      // → Khớp: 9 số bắt đầu bằng đầu số di động VN → thiếu số 0
      cleanPhone = "0" + cleanPhone;
    }

    if (rawPhone !== cleanPhone) {
      // Có thay đổi → ghi log
      logEntries.push([rowNum, "phone", rawPhone, cleanPhone, "PHONE_NORMALIZED"]);
    }

    // Validate kết quả: số đúng chuẩn phải là 0[35789] + 8 số = 10 số tổng
    if (!/^0[35789]\d{8}$/.test(cleanPhone)) {
      // Vẫn không đúng sau tất cả bước → flag để review
      flagRows.push([supId, cleanName, "PHONE_INVALID", "phone", cleanPhone,
        "Không nhận dạng được format — cần xác nhận"]);
    }
    r[colIdx["phone"]] = cleanPhone;


    // ════════════════════════════════════════════════════════════
    // BƯỚC 5: PAYMENT_TERMS — keyword matching
    //
    // Bài toán: 14 cách viết → 3 giá trị chuẩn (NET30 / NET60 / COD)
    //
    // Tại sao dùng keyword matching thay vì bảng mapping cứng?
    //   Bảng cứng: "net30" → NET30, "Net30" → NET30, "30 days" → NET30...
    //   Phải liệt kê đủ 14 cách viết → dễ bỏ sót
    //
    //   Keyword: bất kỳ chuỗi nào chứa "30" → NET30
    //   "30 ngày", "30 days", "NET30", "THANH TOÁN 30 NGÀY" đều có "30"
    //   → 1 rule xử lý được tất cả → ít bảo trì hơn
    //
    // Thứ tự kiểm tra quan trọng:
    //   "30" trước "60": tránh nhầm nếu có chuỗi chứa cả "30" và "60"
    //   (thực tế không có nhưng là best practice — kiểm tra đặc thù trước, chung sau)
    // ════════════════════════════════════════════════════════════
    const rawTerm = String(r[colIdx["payment_terms"]] || "").trim();
    const termLow = rawTerm.toLowerCase();
    // toLowerCase() một lần → so sánh với chữ thường → không cần lo hoa/thường
    let cleanTerm = rawTerm;  // mặc định giữ nguyên

    if (termLow.includes("30")) {
      // Chứa "30" → thuộc nhóm NET30
      // Bắt được: "net30", "Net30", "NET30", "30 days", "30 ngày", "THANH TOÁN 30 NGÀY"
      cleanTerm = "NET30";

    } else if (termLow.includes("60")) {
      // Chứa "60" → thuộc nhóm NET60
      // Bắt được: "net60", "Net60", "NET60", "60 days"
      cleanTerm = "NET60";

    } else if (termLow.includes("cod") || termLow.includes("cash") ||
               termLow.includes("tra ngay") || termLow.includes("trả ngay")) {
      // COD = Cash on Delivery = trả ngay khi nhận hàng
      // Cần kiểm tra cả "trả ngay" (có dấu) và "tra ngay" (không dấu)
      // vì data có thể nhập theo cả 2 cách
      cleanTerm = "COD";

    } else {
      // Không nhận ra → flag, không tự đoán
      // Giữ nguyên giá trị gốc để reviewer thấy
      flagRows.push([supId, cleanName, "PAYMENT_TERMS_UNKNOWN", "payment_terms", rawTerm,
        "Không nhận dạng được — cần xác nhận thuộc NET30/NET60/COD"]);
    }

    if (rawTerm !== cleanTerm) {
      logEntries.push([rowNum, "payment_terms", rawTerm, cleanTerm, "PAYMENT_TERMS_NORMALIZED"]);
    }
    r[colIdx["payment_terms"]] = cleanTerm;


    // ════════════════════════════════════════════════════════════
    // BƯỚC 6: IS_ACTIVE → "Hoạt động" / "Không hoạt động"
    //
    // ĐÂY LÀ VẤN ĐỀ ĐẶC THÙ CỦA GOOGLE SHEETS:
    //   Khi import CSV, Sheets tự động nhận dạng và convert giá trị:
    //     "TRUE"  → JavaScript boolean true  (typeof = "boolean")
    //     "FALSE" → JavaScript boolean false (typeof = "boolean")
    //     "1"     → JavaScript number 1      (typeof = "number")
    //     "0"     → JavaScript number 0      (typeof = "number")
    //   Sau đó getValues() trả về boolean/number, không còn là string nữa
    //
    // Giải pháp: dùng typeof để kiểm tra kiểu dữ liệu thực sự
    //   typeof rawActive === "boolean" → xử lý trực tiếp true/false
    //   typeof rawActive === "number"  → xử lý trực tiếp 1/0
    //   else                           → string còn lại → toLowerCase → so sánh
    //
    // Tại sao output là "Hoạt động"/"Không hoạt động" thay vì TRUE/FALSE?
    //   Sheets lại parse "TRUE"/"FALSE" thành checkbox boolean khi ghi vào sheet
    //   Text tiếng Việt → Sheets không nhận ra → lưu đúng dạng text
    // ════════════════════════════════════════════════════════════
    const rawActive = r[colIdx["is_active"]];
    // rawActive có thể là: boolean true/false | number 1/0 | string
    let cleanActive = "";

    if (typeof rawActive === "boolean") {
      // Sheets đã parse "TRUE"/"FALSE" thành boolean JavaScript thật sự
      // rawActive === true → "Hoạt động", rawActive === false → "Không hoạt động"
      cleanActive = rawActive === true ? "Hoạt động" : "Không hoạt động";

    } else if (typeof rawActive === "number") {
      // Sheets đã parse "1"/"0" thành number JavaScript
      // rawActive === 1 → "Hoạt động", bất kỳ số nào khác → "Không hoạt động"
      cleanActive = rawActive === 1 ? "Hoạt động" : "Không hoạt động";

    } else {
      // String hoặc giá trị không xác định
      const rawStr = String(rawActive || "").trim().toLowerCase();
      // String(rawActive || ""): nếu null/undefined → dùng "" thay thế
      // .trim().toLowerCase() → chuẩn hoá để so sánh

      if (rawStr === "true" || rawStr === "hoạt động") {
        cleanActive = "Hoạt động";
      } else if (rawStr === "false" || rawStr === "" || rawStr === "null"
                 || rawStr === "không hoạt động") {
        cleanActive = "Không hoạt động";
      } else {
        // Giá trị lạ không nhận ra → set mặc định + flag
        cleanActive = "Không hoạt động";
        flagRows.push([supId, cleanName, "IS_ACTIVE_UNKNOWN", "is_active", rawStr,
          "Không nhận dạng được — đã set mặc định Không hoạt động"]);
      }
    }

    // Ghi log: cần convert rawActive sang string để ghi vào log
    // (typeof boolean/number thì String() ép sang "true"/"false"/"1"/"0")
    const rawActiveStr = String(rawActive ?? "");
    // ?? = nullish coalescing: nếu rawActive là null/undefined → dùng ""
    if (rawActiveStr !== cleanActive) {
      logEntries.push([rowNum, "is_active", rawActiveStr, cleanActive, "IS_ACTIVE_NORMALIZED"]);
    }
    r[colIdx["is_active"]] = cleanActive;


    // Thêm hàng đã xử lý vào danh sách kết quả
    cleanRows.push(r);
    rowNum++;  // tăng bộ đếm hàng cho lần lặp tiếp theo
  });


  // ════════════════════════════════════════════════════════════
  // BƯỚC 7: FUZZY DEDUPLICATION — xử lý SAU vòng lặp chính
  //
  // Tại sao xử lý sau vòng lặp, không trong vòng lặp?
  //   Fuzzy matching cần so sánh từng cặp tên với nhau
  //   Nếu xử lý trong vòng lặp: khi đang ở hàng 5, chưa có hàng 6,7,8...
  //   Phải đợi sau khi đã xử lý hết tất cả hàng mới so sánh chéo được
  //
  // Kỹ thuật trong GAS (không có thư viện thefuzz như Python):
  //   Bước 1: normalizeForFuzzy() — chuẩn hoá tên để so sánh
  //     + Bỏ stop words: "công ty", "cty", "tnhh", "cp"...
  //     + Bỏ dấu tiếng Việt
  //     + Lowercase + xóa ký tự đặc biệt
  //     Kết quả: "Công Ty TNHH Thực Phẩm Sao Vàng" → "thuc pham sao vang"
  //              "Cty TNHH Thực Phẩm Sao Vàng"    → "thuc pham sao vang"
  //     → 2 chuỗi giống hệt nhau → phát hiện fuzzy duplicate
  //
  //   Bước 2: Dùng Map (normalizedMap) lưu: chuỗi chuẩn hoá → thông tin NCC
  //     Khi thấy chuỗi đã tồn tại trong Map → FLAG cả 2 bên
  //
  // Giới hạn của kỹ thuật này:
  //   Chỉ phát hiện khi tên giống hệt sau normalize
  //   "Sao Vàng" vs "Sao Vang" (khác dấu) vẫn → giống nhau (đã bỏ dấu)
  //   "ABC Food" vs "ABC Foods" (thêm "s") → KHÔNG phát hiện được
  //   → Python với thefuzz có thể xử lý tốt hơn (sẽ viết sau)
  // ════════════════════════════════════════════════════════════

  // Stop words: các từ phổ biến trong tên công ty VN, không mang thông tin phân biệt
  // Sắp xếp dài → ngắn: "nha phan phoi" phải được xóa trước "nha"
  // Nếu xóa "nha" trước: "nha phan phoi" → " phan phoi" (còn sót)
  const STOP_WORDS = [
    "nha phan phoi",  // 14 ký tự — dài nhất, xóa trước
    "phan phoi",      // 8 ký tự
    "cong ty",        // 7 ký tự
    "tnhh",           // 4 ký tự
    "nha",            // 3 ký tự
    "cty",            // 3 ký tự
    "cp",             // 2 ký tự — ngắn nhất, xóa sau
  ];

  // Hàm chuẩn hoá tên để so sánh fuzzy
  function normalizeForFuzzy(name) {
    // Bước 1: bỏ dấu và lowercase — "Sao Vàng" → "sao vang"
    let s = removeDiacritics(name.toLowerCase());

    // Bước 2: xóa stop words theo thứ tự dài → ngắn
    // split(word).join(" "): thay thế tất cả occurrences của word bằng " "
    // An toàn hơn replace() vì không cần escape ký tự đặc biệt trong regex
    STOP_WORDS.forEach(w => {
      s = s.split(w).join(" ");
    });

    // Bước 3: xóa ký tự không phải chữ/số, chuẩn hoá khoảng trắng
    // [^a-z0-9] = bất kỳ ký tự nào không phải a-z hoặc 0-9
    // \s+ = 1 hoặc nhiều khoảng trắng → thay bằng 1 khoảng trắng
    return s.replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  }

  // Map lưu: normalized_name → { id: supplier_id, name: tên đã clean }
  // Khi gặp normalized_name đã có trong map → phát hiện fuzzy duplicate
  const normalizedMap = {};

  cleanRows.forEach(r => {
    const supId = r[colIdx["supplier_id"]];
    const name  = r[colIdx["supplier_name"]];
    const norm  = normalizeForFuzzy(name);  // chuỗi đã chuẩn hoá

    if (!norm) return;  // bỏ qua nếu tên rỗng sau normalize

    if (normalizedMap[norm]) {
      // Đã thấy normalized name này trước đó → fuzzy duplicate
      const prev = normalizedMap[norm];  // thông tin NCC đã thấy trước

      // Flag NCC hiện tại
      flagRows.push([supId, name,
        "FUZZY_DUPLICATE", "supplier_name", name,
        "Tên gần giống " + prev.id + " (" + prev.name + ") — cần xác nhận có phải cùng NCC"
      ]);

      // Flag NCC trước đó (nếu chưa bị flag)
      // some() = kiểm tra xem có phần tử nào thỏa điều kiện không
      const alreadyFlagged = flagRows.some(f =>
        f[0] === prev.id && f[2] === "FUZZY_DUPLICATE"
      );
      if (!alreadyFlagged) {
        flagRows.push([prev.id, prev.name,
          "FUZZY_DUPLICATE", "supplier_name", prev.name,
          "Tên gần giống " + supId + " (" + name + ") — cần xác nhận có phải cùng NCC"
        ]);
      }

    } else {
      // Chưa thấy → ghi nhớ vào map để kiểm tra các NCC sau
      normalizedMap[norm] = { id: supId, name: name };
    }
  });


  // ── GHI KẾT QUẢ — Batch write 1 lần duy nhất ────────────────
  // Không ghi từng ô riêng lẻ — mỗi lần ghi = 1 lần gọi API đến server Google
  // Ghi batch 1 lần nhanh hơn vòng lặp ghi từng ô rất nhiều

  // Ghi suppliers_clean
  cleanSheet.clearContents();  // xóa nội dung cũ nếu có
  // Ghi header: [headers] = bọc thêm [] vì setValues() nhận mảng 2 chiều [[row]]
  cleanSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (cleanRows.length > 0) {
    // Ghi data từ hàng 2 (hàng 1 là header)
    // getRange(2, 1, numRows, numCols).setValues(mảng 2 chiều)
    cleanSheet.getRange(2, 1, cleanRows.length, headers.length).setValues(cleanRows);
  }

  // Ghi Cleaning_Log
  logSheet.clearContents();
  // logEntries[0] = header row → logEntries[0].length = số cột
  logSheet.getRange(1, 1, logEntries.length, logEntries[0].length).setValues(logEntries);

  // Ghi Flagged
  flagSheet.clearContents();
  flagSheet.getRange(1, 1, 1, flagHeaders.length).setValues([flagHeaders]);
  if (flagRows.length > 0) {
    flagSheet.getRange(2, 1, flagRows.length, flagHeaders.length).setValues(flagRows);
  }

  // In tóm tắt ra Logger (View → Logs để xem)
  Logger.log("✅ Clean: " + cleanRows.length +
             " | Log: " + (logEntries.length - 1) +
             " | Flagged: " + flagRows.length);
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  HELPER FUNCTIONS — Các hàm tiện ích                        ║
// ╚══════════════════════════════════════════════════════════════╝

// ── Bỏ dấu tiếng Việt → ASCII ────────────────────────────────────
// Dùng để chuẩn hoá email và tên NCC trước khi so sánh
// Kỹ thuật: dùng 2 chuỗi FROM/TO song song
//   FROM: chuỗi tất cả ký tự có dấu (đặt theo thứ tự)
//   TO:   chuỗi ký tự không dấu tương ứng (cùng vị trí index)
//   Với mỗi ký tự trong input: tìm vị trí trong FROM → lấy ký tự cùng vị trí trong TO
//
// Tại sao không dùng object map { 'à': 'a', 'á': 'a', ... }?
//   Object map bị lỗi encoding khi tạo file tự động (script Python tạo .gs)
//   Ký tự có dấu bị mất → map rỗng → không bỏ được dấu
//   String FROM/TO không bị vấn đề này vì JS đọc trực tiếp từng ký tự Unicode
function removeDiacritics(str) {
  const FROM = "àáảãạăắặằẳẵâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵÀÁẢÃẠĂẮẶẰẲẴÂẤẦẨẪẬĐÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴ";
  const TO   = "aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyYaaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy";
  // FROM và TO phải có cùng số ký tự (134 mỗi chuỗi) — đã verify khi tạo file

  let result = "";
  for (let i = 0; i < str.length; i++) {
    const idx = FROM.indexOf(str[i]);
    // indexOf: tìm vị trí ký tự trong FROM, trả về -1 nếu không tìm thấy
    result += idx >= 0 ? TO[idx] : str[i];
    // Nếu tìm thấy → lấy ký tự không dấu tương ứng từ TO
    // Nếu không → giữ nguyên ký tự (không phải tiếng Việt có dấu)
  }
  return result.toLowerCase();  // lowercase toàn bộ kết quả
}


// ── Chèn @ vào email thiếu dấu @ ─────────────────────────────────
// Nhận diện domain trong chuỗi → chèn @ trước domain → bỏ dấu local
// Trả về email đã sửa, hoặc null nếu không nhận ra domain
//
// Thứ tự domain DÀI → NGẮN (quan trọng!):
//   Nếu tìm "com" trước: "cpdientugmail.com" → match "com" tại vị trí 10
//   → "@ail.com" (sai) thay vì "@gmail.com"
//   Tìm "gmail.com" (9 ký tự) trước "com" (3 ký tự) → tránh match nhầm
function fixMissingAt(email) {
  const domains = ["outlook.com", "company.vn", "gmail.com", "yahoo.com"];
  const lower   = email.toLowerCase();  // lowercase để tìm kiếm không phân biệt hoa thường

  for (const d of domains) {
    const idx = lower.indexOf(d);  // tìm domain trong chuỗi
    if (idx > 0) {
      // idx > 0: domain tìm thấy VÀ có phần local trước đó (idx=0 = không có local)
      const local = email.substring(0, idx);   // phần trước domain: "cpđiệntử"
      const dom   = email.substring(idx);      // domain: "gmail.com"
      return removeDiacritics(local) + "@" + dom;
      // Bỏ dấu local + thêm @ + giữ nguyên domain
    }
  }
  return null;  // không nhận ra domain nào → caller sẽ flag EMAIL_BROKEN
}


// ── Chuẩn hoá tên công ty ─────────────────────────────────────────
// 3 bước: expand từ viết tắt → title case → giữ ALL CAPS cho abbr
//
// Tại sao không dùng str.replace(/\b\w/g) cho tiếng Việt?
//   \b và \w chỉ nhận ký tự ASCII — không nhận "đ","ă","ơ","ị"...
//   "trần" → \b khớp trước "t" nhưng "r","ầ","n" không được xử lý → sai
//   Giải pháp: split theo khoảng trắng → capitalize thủ công từng từ
function toTitleCase(str) {

  // Bước 1: Expand từ viết tắt phổ biến trong tên công ty VN
  // Map key: lowercase của từ cần expand
  // Map value: chuỗi thay thế chuẩn (có dấu tiếng Việt đầy đủ)
  const EXPAND_MAP = {
    "cty": "Công Ty",       // "Cty TNHH ABC" → "Công Ty TNHH ABC"
    "ncc": "Nhà Cung Cấp",  // "NCC ABC" → "Nhà Cung Cấp ABC"
  };

  // Tách thành mảng từ → map từng từ qua EXPAND_MAP → nối lại
  let words = str.trim().split(/\s+/);
  // /\s+/ = 1 hoặc nhiều khoảng trắng → tách đúng dù có nhiều space liên tiếp
  words = words.map(w => EXPAND_MAP[w.toLowerCase()] || w);
  // w.toLowerCase() để tra map không phân biệt hoa thường
  // || w: nếu không có trong map → giữ nguyên từ đó
  let s = words.join(" ");  // nối lại thành chuỗi

  // Bước 2: Title case từng từ
  // charAt(0).toUpperCase() = viết hoa ký tự đầu
  // slice(1).toLowerCase()  = lowercase phần còn lại
  s = s.split(/\s+/).map(w =>
    w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  ).join(" ");

  // Bước 3: Đảm bảo từ viết tắt luôn ALL CAPS
  // Sau bước title case: "Tnhh" → phải là "TNHH", "Cp" → "CP"
  // So sánh: w.toUpperCase() === abbr
  //   "Tnhh".toUpperCase() = "TNHH" === "TNHH" → true → thay bằng "TNHH"
  //   "Thuc".toUpperCase() = "THUC" ≠ "TNHH"   → false → giữ nguyên "Thuc"
  const ABBR_LIST = ["TNHH", "CP", "MTV", "XD", "TM", "DV", "SX", "XNK", "ABC"];
  ABBR_LIST.forEach(abbr => {
    s = s.split(" ").map(w =>
      w.toUpperCase() === abbr ? abbr : w
    ).join(" ");
  });

  return s;
}


// ── Xóa sheet nếu tồn tại ────────────────────────────────────────
// An toàn hơn ss.deleteSheet() vì không báo lỗi nếu sheet chưa có
function deleteSheetIfExists(ss, name) {
  const s = ss.getSheetByName(name);
  if (!s) return;  // chưa có → không làm gì

  // Sheets không cho xóa sheet duy nhất còn lại trong file
  if (ss.getSheets().length === 1) {
    s.clearContents();  // chỉ xóa nội dung, giữ sheet
    return;
  }
  ss.deleteSheet(s);  // xóa hẳn: nội dung + format + filter
}


// ── Lấy sheet theo tên, tạo mới nếu chưa có ─────────────────────
function getOrCreateSheet(ss, name) {
  let s = ss.getSheetByName(name);
  if (!s) s = ss.insertSheet(name);  // tạo sheet mới với tên đó
  return s;
}
