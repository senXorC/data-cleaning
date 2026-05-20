/**
 * ============================================================
 * ECOMMERCE — CUSTOMERS DATA CLEANING
 * Link google sheets: https://docs.google.com/spreadsheets/d/1Az5TJslLFpjIHX1JIMVbWb2OxQH0_iKe2aFakoTvVLM/edit?gid=2026485316#gid=2026485316
 * ============================================================
 * CÁCH DÙNG:
 *   1. Tạo Google Sheets mới → File → Import → customers_dirty.csv
 *      Đặt tên sheet là "customers_dirty"
 *   2. Extensions → Apps Script → paste file này
 *   3. Run: runCustomersCleaning()
 *
 * OUTPUT:
 *   - customers_clean : dữ liệu sạch
 *   - Cleaning_Log    : audit trail
 *   - Flagged         : dòng cần review
 * ============================================================
 */

const CUST_DATA_COLS = 7; // customer_id, full_name, email, phone, city, registration_date, membership_tier

function runCustomersCleaning() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName("customers_dirty") || ss.getSheets()[0];

  Logger.log("=== BẮT ĐẦU LÀM SẠCH CUSTOMERS ===");

  // Xóa sheet cũ → tạo lại sạch
  deleteSheetIfExists(ss, "customers_clean");
  deleteSheetIfExists(ss, "Cleaning_Log");
  deleteSheetIfExists(ss, "Flagged");

  const cleanSheet = getOrCreateSheet(ss, "customers_clean");
  const logSheet   = getOrCreateSheet(ss, "Cleaning_Log");
  const flagSheet  = getOrCreateSheet(ss, "Flagged");

  cleanCustomersData(rawSheet, cleanSheet, logSheet, flagSheet);

  SpreadsheetApp.getUi().alert("✅ Customers cleaning xong!\nXem: customers_clean, Cleaning_Log, Flagged");
}


function cleanCustomersData(rawSheet, cleanSheet, logSheet, flagSheet) {

  // ── ĐỌC DỮ LIỆU ─────────────────────────────────────────────
  // Giới hạn CUST_DATA_COLS để bỏ qua cột ghi chú thừa nếu có
  const data    = rawSheet.getRange(1, 1, rawSheet.getLastRow(), CUST_DATA_COLS).getValues();
  const headers = data[0];
  const rows    = data.slice(1);

  // Bảng tra cứu vị trí cột theo tên → colIdx["customer_id"] thay vì colIdx[0]
  const colIdx = {};
  headers.forEach((h, i) => colIdx[h] = i);

  // ── HEADER OUTPUT ─────────────────────────────────────────────
  // Không thêm cột phái sinh cho customers — schema đơn giản
  const allHeaders  = [...headers];
  const logHeaders  = ["row_original", "field", "old_value", "new_value", "action"];
  const flagHeaders = ["row_id", "flag_type", "field", "value", "note"];

  const cleanRows = [];
  const logEntries  = [logHeaders];
  const flagRows    = [];
  const seenIds     = new Set();
  let   rowNum      = 2;


  rows.forEach((row) => {
    const r      = [...row]; // bản sao — không sửa row gốc
    const custId = r[colIdx["customer_id"]];


    // ════════════════════════════════════════════════════════════
    // BƯỚC 1: DUPLICATE
    // ════════════════════════════════════════════════════════════
    if (seenIds.has(custId)) {
      logEntries.push([rowNum, "customer_id", custId, "", "DROPPED_DUPLICATE"]);
      rowNum++; return;
    }
    seenIds.add(custId);


    // ════════════════════════════════════════════════════════════
    // BƯỚC 2: FULL_NAME — Title Case tiếng Việt
    // ════════════════════════════════════════════════════════════
    const rawName  = String(r[colIdx["full_name"]] || "").trim();
    const cleanName = rawName ? toTitleCase(rawName) : "Không xác định";
    if (rawName !== cleanName) {
      logEntries.push([rowNum, "full_name", rawName, cleanName, "NAME_NORMALIZED"]);
    }
    r[colIdx["full_name"]] = cleanName;


    // ════════════════════════════════════════════════════════════
    // BƯỚC 3: EMAIL — bỏ dấu, thêm @, flag broken
    // ════════════════════════════════════════════════════════════
    const rawEmail = String(r[colIdx["email"]] || "").trim();
    let   cleanEmail = rawEmail;
    let   emailValid = false;

    if (!rawEmail) {
      logEntries.push([rowNum, "email", "", "", "EMAIL_NULL"]);

    } else if (rawEmail.includes("@")) {
      // Có @ → kiểm tra dấu tiếng Việt phần local
      const atIdx      = rawEmail.indexOf("@");
      const local      = rawEmail.substring(0, atIdx);
      const domain     = rawEmail.substring(atIdx);
      const localClean = removeDiacritics(local);
      if (local !== localClean) {
        cleanEmail = localClean + domain;
        logEntries.push([rowNum, "email", rawEmail, cleanEmail, "EMAIL_DIACRITIC_REMOVED"]);
      }
      emailValid = true;

    } else {
      // Thiếu @ → thử tìm domain
      const fixed = fixMissingAt(rawEmail);
      if (fixed) {
        cleanEmail = fixed;
        logEntries.push([rowNum, "email", rawEmail, cleanEmail, "EMAIL_AT_INSERTED"]);
        emailValid = true;
      } else {
        logEntries.push([rowNum, "email", rawEmail, "", "EMAIL_BROKEN"]);
        flagRows.push([custId, "EMAIL_INVALID", "email", rawEmail, "Email không hợp lệ — cần xác nhận"]);
      }
    }
    r[colIdx["email"]] = cleanEmail;


    // ════════════════════════════════════════════════════════════
    // BƯỚC 4: PHONE — chuẩn hoá về 10 số bắt đầu 0
    //
    // Các trường hợp tự sửa được (rule rõ ràng, không ambiguous):
    //   +84xxxxxxxxx (11 ký tự) → bỏ +84, thêm 0 → 10 số
    //   84xxxxxxxxx  (11 ký tự) → bỏ 84,  thêm 0 → 10 số
    //   9xxxxxxxx   (9 ký tự)  → thêm 0 ở đầu  → 10 số
    //     Lý do tự sửa 9 số: số Việt Nam bắt đầu 9x khi thiếu 0
    //     Pattern 100% rõ → không cần flag, tự sửa luôn
    //
    // Chỉ flag khi không thuộc bất kỳ pattern nào trên
    // ════════════════════════════════════════════════════════════
    const rawPhone  = String(r[colIdx["phone"]] || "").trim();
    let   cleanPhone = rawPhone.replace(/[\s\-\.]/g, ""); // xóa dấu gạch, space, chấm

    if (cleanPhone.startsWith("+84") && cleanPhone.length === 12) {
      // +84xxxxxxxxx → 0xxxxxxxxx
      cleanPhone = "0" + cleanPhone.substring(3);

    } else if (cleanPhone.startsWith("84") && cleanPhone.length === 11) {
      // 84xxxxxxxxx (thiếu +) → 0xxxxxxxxx
      cleanPhone = "0" + cleanPhone.substring(2);

    } else if (/^[35789]\d{8}$/.test(cleanPhone)) {
      // 9 số bắt đầu bằng 3,5,7,8,9 (đầu số di động Việt Nam) → thiếu số 0
      // Regex: ^[35789] = bắt đầu bằng 1 trong các số này, \d{8} = 8 số tiếp theo
      // VD: "940099522" → "0940099522"
      cleanPhone = "0" + cleanPhone;
    }

    // Ghi log nếu có thay đổi
    if (rawPhone !== cleanPhone) {
      logEntries.push([rowNum, "phone", rawPhone, cleanPhone, "PHONE_NORMALIZED"]);
    }

    // Chỉ flag khi sau tất cả các bước trên vẫn không đúng 10 số
    // Những trường hợp còn lại là thực sự không rõ → cần review
    if (!/^0[35789]\d{8}$/.test(cleanPhone)) {
      flagRows.push([custId, "PHONE_INVALID", "phone", cleanPhone,
        "Không nhận dạng được format — cần xác nhận thủ công"]);
    }
    r[colIdx["phone"]] = cleanPhone;


    // ════════════════════════════════════════════════════════════
    // BƯỚC 5: MEMBERSHIP_TIER — normalize Bronze/bronze/GOLD → chuẩn
    // ════════════════════════════════════════════════════════════
    const tierMap = {"bronze":"Bronze","silver":"Silver","gold":"Gold","platinum":"Platinum"};
    const rawTier = String(r[colIdx["membership_tier"]] || "").trim();
    const cleanTier = tierMap[rawTier.toLowerCase()] || (rawTier || "Không xác định");
    if (rawTier !== cleanTier) {
      logEntries.push([rowNum, "membership_tier", rawTier, cleanTier, "TIER_NORMALIZED"]);
    }
    r[colIdx["membership_tier"]] = cleanTier;


    // ════════════════════════════════════════════════════════════
    // BƯỚC 6: REGISTRATION_DATE — chuẩn hoá format
    // ════════════════════════════════════════════════════════════
    const rawDate = r[colIdx["registration_date"]];
    const parsedDate = parseViDate(rawDate instanceof Date
      ? Utilities.formatDate(rawDate, "UTC", "dd/MM/yyyy")
      : String(rawDate || ""));
    if (parsedDate) {
      const formatted = Utilities.formatDate(parsedDate, "UTC", "yyyy-MM-dd");
      if (String(rawDate) !== formatted) {
        logEntries.push([rowNum, "registration_date", rawDate, formatted, "DATE_NORMALIZED"]);
      }
      r[colIdx["registration_date"]] = formatted;
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


// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function removeDiacritics(str) {
  const map = {
    'à':'a','á':'a','ả':'a','ã':'a','ạ':'a',
    'ă':'a','ắ':'a','ặ':'a','ằ':'a','ẳ':'a','ẵ':'a',
    'â':'a','ấ':'a','ầ':'a','ẩ':'a','ẫ':'a','ậ':'a',
    'đ':'d',
    'è':'e','é':'e','ẻ':'e','ẽ':'e','ẹ':'e',
    'ê':'e','ế':'e','ề':'e','ể':'e','ễ':'e','ệ':'e',
    'ì':'i','í':'i','ỉ':'i','ĩ':'i','ị':'i',
    'ò':'o','ó':'o','ỏ':'o','õ':'o','ọ':'o',
    'ô':'o','ố':'o','ồ':'o','ổ':'o','ỗ':'o','ộ':'o',
    'ơ':'o','ớ':'o','ờ':'o','ở':'o','ỡ':'o','ợ':'o',
    'ù':'u','ú':'u','ủ':'u','ũ':'u','ụ':'u',
    'ư':'u','ứ':'u','ừ':'u','ử':'u','ữ':'u','ự':'u',
    'ỳ':'y','ý':'y','ỷ':'y','ỹ':'y','ỵ':'y',
  };
  return str.toLowerCase().split('').map(c => map[c] || c).join('');
}

function fixMissingAt(email) {
  // Tìm domain dài → ngắn để tránh match nhầm
  const domains = ["outlook.com","company.vn","gmail.com","yahoo.com"];
  const lower   = email.toLowerCase();
  for (const d of domains) {
    const idx = lower.indexOf(d);
    if (idx > 0) return removeDiacritics(email.substring(0, idx)) + "@" + email.substring(idx);
  }
  return null;
}

function toTitleCase(str) {
  return str.trim().toLowerCase()
    .split(/\s+/)
    .map(w => w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

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
  return null;
}

function isValidParts(d, mo, y) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo-1, d));
  return t.getUTCFullYear()===y && t.getUTCMonth()===mo-1 && t.getUTCDate()===d;
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
