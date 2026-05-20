# =============================================================================
# HR EMPLOYEES DATA CLEANING — Python / pandas
# Dataset : data/raw/hr_dirty.csv  (~200 rows)
#
# ĐỒNG BỘ VỚI: google-apps-script/02_hr_cleaning.gs
# Mọi quyết định xử lý ở đây giống hệt bên GAS để 2 pipeline
# cho ra kết quả nhất quán khi chạy trên cùng dataset.
#
# OUTPUT:
#   data/clean/hr_clean.csv          ← dữ liệu sạch cho analyst
#   data/clean/hr_cleaning_log.csv   ← audit trail mọi thay đổi
#   data/clean/hr_flagged.csv        ← dòng cần người review xem lại
#
# CẤU TRÚC FILE (đọc từ trên xuống):
#   1. HELPER FUNCTIONS  ← khai báo trước, dùng trong các bước
#   2. ĐỌC DỮ LIỆU
#   3. BƯỚC 1 — TỔNG QUAN
#   4. BƯỚC 2 — MISSING VALUES
#   5. BƯỚC 3 — THỐNG KÊ MÔ TẢ
#   6. BƯỚC 4 — CHẨN ĐOÁN
#   7. BƯỚC 5 — LÀM SẠCH (10 bước xử lý)
#   8. BƯỚC 6 — VALIDATE
#   9. BƯỚC 7 — EXPORT
# =============================================================================

import pandas as pd
import numpy as np
import re


# ═════════════════════════════════════════════════════════════════
# HELPER FUNCTIONS — Khai báo trước, dùng trong các bước bên dưới
# ═════════════════════════════════════════════════════════════════

def parse_vi_date(s):
    """
    Parse chuỗi ngày Việt Nam → (Timestamp | NaT, inferred: bool)
    Thứ tự thử: YYYY-MM-DD → DD/MM/YYYY → DD-MM-YYYY → suy luận MM/DD
    inferred=True khi dùng suy luận MM/DD — ghi log riêng để review
    """
    if pd.isnull(s) or str(s).strip() == "":
        return pd.NaT, False

    s = str(s).strip()

    # Format 1: YYYY-MM-DD
    try:
        return pd.to_datetime(s, format="%Y-%m-%d"), False
    except ValueError:
        pass

    # Format 2 & 3: DD/MM/YYYY hoặc DD-MM-YYYY (chuẩn Việt Nam)
    m = re.match(r'^(\d{2})[/\-](\d{2})[/\-](\d{4})$', s)
    if m:
        p1, p2, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        # Bước 1: thử DD/MM (chuẩn Việt Nam)
        if 1 <= p2 <= 12 and 1 <= p1 <= 31:
            try:
                return pd.to_datetime(f"{year}-{p2:02d}-{p1:02d}",
                                      format="%Y-%m-%d"), False
            except ValueError:
                pass
        # Bước 2: suy luận MM/DD nếu p2 > 12 (p2 không thể là tháng)
        if 1 <= p1 <= 12 and 1 <= p2 <= 31:
            try:
                return pd.to_datetime(f"{year}-{p1:02d}-{p2:02d}",
                                      format="%Y-%m-%d"), True
            except ValueError:
                pass
        return pd.NaT, False

    return pd.NaT, False


def normalize_gender(val):
    """
    Chuẩn hoá 9 cách viết gender → Nam / Nữ / Không xác định
    Nguyên lý: lowercase → tra bảng mapping → trả giá trị chuẩn
    """
    if pd.isnull(val):
        return "Không xác định"
    gender_map = {
        "nam": "Nam", "male": "Nam", "m": "Nam",
        "nữ": "Nữ",  "nu":  "Nữ",  "female": "Nữ", "f": "Nữ",
    }
    key = str(val).strip().lower()
    return gender_map.get(key, str(val).strip() or "Không xác định")


def normalize_education(val):
    """Chuẩn hoá tên trình độ học vấn qua bảng mapping"""
    if pd.isnull(val):
        return "Không xác định"
    edu_map = {
        "đại học": "Đại học", "đhục": "Đại học",
        "thạc sĩ": "Thạc sĩ", "tiến sĩ": "Tiến sĩ",
        "cao đẳng": "Cao đẳng", "thpt": "THPT",
    }
    key = str(val).strip().lower()
    return edu_map.get(key, str(val).strip() or "Không xác định")


def title_case_vi(s):
    """
    Title Case hỗ trợ Unicode tiếng Việt.
    Không dùng str.title() vì xử lý sai một số edge case Unicode.
    Không dùng \b\w vì chỉ nhận ASCII, bỏ sót "đ","ă","ơ"...
    Giải pháp: strip → lower → split → capitalize từng từ → join
    """
    if pd.isnull(s) or str(s).strip() == "":
        return "Không xác định"
    return " ".join(w.capitalize() for w in str(s).strip().lower().split())


def remove_diacritics(s):
    """
    Bỏ dấu tiếng Việt → ASCII, dùng để chuẩn hoá phần local email
    Nguyên lý: lowercase → map từng ký tự → giữ nguyên nếu không có trong map
    """
    if pd.isnull(s):
        return ""
    diac_map = str.maketrans(
        "àáảãạăắặằẳẵâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ"
        "ÀÁẢÃẠĂẮẶẰẲẴÂẤẦẨẪẬĐÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴ",
        "aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy"
        "aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy"
    )
    return str(s).lower().translate(diac_map)


def fix_missing_at(email):
    """
    Chèn @ vào email thiếu dấu @.
    Tìm domain trong chuỗi (dài → ngắn để tránh match nhầm) → chèn @ + bỏ dấu local.
    Trả None nếu không nhận ra domain nào → caller sẽ flag EMAIL_BROKEN.

    Thứ tự domain DÀI → NGẮN là quan trọng:
    "company.vn" phải tìm trước "com" để tránh "company.vn" bị cắt thành "pany.vn"
    """
    if pd.isnull(email) or not email:
        return None
    # Sắp xếp domain dài → ngắn
    known_domains = ["outlook.com", "company.vn", "gmail.com", "yahoo.com"]
    lower = email.lower()
    for domain in known_domains:
        idx = lower.find(domain)
        if idx > 0:
            # idx > 0: có phần local trước domain
            local = email[:idx]           # phần trước domain (chưa có @)
            dom   = email[idx:]           # domain
            clean_local = remove_diacritics(local)  # bỏ dấu local
            return clean_local + "@" + dom
    return None  # không nhận ra domain


def make_log(row_num, field, old_val, new_val, action):
    """Helper tạo log entry chuẩn 5 trường — dùng thống nhất trong toàn file"""
    return {
        "row_original": row_num,
        "field":        field,
        "old_value":    old_val,
        "new_value":    new_val,
        "action":       action,
    }


def make_flag(emp_id, full_name, flag_type, field, value, note):
    """Helper tạo flag entry 6 trường — ghi vào hr_flagged.csv"""
    return {
        "emp_id":    emp_id,
        "full_name": full_name,
        "flag_type": flag_type,
        "field":     field,
        "value":     value,
        "note":      note,
    }


# ═════════════════════════════════════════════════════════════════
# ĐỌC DỮ LIỆU
# ═════════════════════════════════════════════════════════════════

# Chỉ đọc 14 cột schema thực — bỏ qua cột ghi chú nếu file có thêm
DATA_COLS = [
    "emp_id", "full_name", "gender", "birth_year", "age",
    "city", "email", "department", "position", "hire_date",
    "salary_k_vnd", "education", "perf_score", "leave_days"
]

df_raw = pd.read_csv("data/raw/hr_dirty.csv", usecols=DATA_COLS)
df     = df_raw.copy()   # KHÔNG BAO GIỜ sửa trực tiếp df_raw

# Khởi tạo log và flagged — cùng cấu trúc với GAS để dễ so sánh
log      = []  # audit trail → hr_cleaning_log.csv
flagged  = []  # dòng cần review → hr_flagged.csv


# ═════════════════════════════════════════════════════════════════
# BƯỚC 1 — TỔNG QUAN
# ═════════════════════════════════════════════════════════════════

print("=" * 60)
print("BƯỚC 1 — TỔNG QUAN")
print("=" * 60)
print(f"Shape    : {df.shape}")
print(f"Columns  : {list(df.columns)}")
print(f"\ndtypes:\n{df.dtypes}")
print(f"\nHead:\n{df.head(3).to_string()}")


# ═════════════════════════════════════════════════════════════════
# BƯỚC 2 — MISSING VALUES
# ═════════════════════════════════════════════════════════════════

print("\n" + "=" * 60)
print("BƯỚC 2 — MISSING VALUES")
print("=" * 60)
miss = pd.DataFrame({
    "count": df.isnull().sum(),
    "pct_%": (df.isnull().mean() * 100).round(2)
})
print(miss[miss["count"] > 0].to_string()
      if miss["count"].sum() > 0 else "Không có null")


# ═════════════════════════════════════════════════════════════════
# BƯỚC 3 — THỐNG KÊ MÔ TẢ
# ═════════════════════════════════════════════════════════════════

print("\n" + "=" * 60)
print("BƯỚC 3 — THỐNG KÊ MÔ TẢ")
print("=" * 60)
print(df.describe(include="all").T.to_string())


# ═════════════════════════════════════════════════════════════════
# BƯỚC 4 — CHẨN ĐOÁN
# ═════════════════════════════════════════════════════════════════

print("\n" + "=" * 60)
print("BƯỚC 4 — CHẨN ĐOÁN")
print("=" * 60)
print(f"[Duplicate]   {df.duplicated().sum()} dòng trùng")
print(f"\n[Gender]      {df['gender'].nunique(dropna=False)} unique:")
print(df["gender"].value_counts(dropna=False).to_string())
print(f"\n[Age]         range {df['age'].min()}–{df['age'].max()}")
print(f"  Ngoài 18–65: {(~df['age'].between(18,65)).sum()} dòng")
sal = pd.to_numeric(df["salary_k_vnd"], errors="coerce")
print(f"\n[Salary]      range {sal.min():,.0f}–{sal.max():,.0f}")
print(f"  Âm: {(sal<0).sum()} | Outlier >10M: {(sal>10_000_000).sum()}")
print(f"\n[perf_score]  out of range (1-5): "
      f"{(~pd.to_numeric(df['perf_score'],errors='coerce').between(1,5)).sum()}")
print(f"\n[Education]   {df['education'].nunique(dropna=False)} unique:")
print(df["education"].value_counts(dropna=False).to_string())
broken = df["email"].dropna()[~df["email"].dropna().str.contains("@")]
print(f"\n[Email]       broken (no @): {len(broken)}")
print(f"  có dấu tiếng Việt: "
      f"{df['email'].dropna().apply(lambda x: bool(re.search('[àáảãạăắặằẳẵâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]', str(x)))).sum()}")
print(f"\n[hire_date]   mẫu: {df['hire_date'].head(5).tolist()}")


# ═════════════════════════════════════════════════════════════════
# BƯỚC 5 — LÀM SẠCH
# ═════════════════════════════════════════════════════════════════

print("\n" + "=" * 60)
print("BƯỚC 5 — LÀM SẠCH")
print("=" * 60)


# ── XỬ LÝ 1: DUPLICATE ──────────────────────────────────────────
# Ghi log trước khi drop để có row_original chính xác
dup_mask = df.duplicated(keep="first")
for idx in df[dup_mask].index:
    log.append(make_log(idx+2, "emp_id", df.loc[idx,"emp_id"], "", "DROPPED_DUPLICATE"))
before = len(df)
df = df.drop_duplicates(keep="first")
print(f"[Duplicate] Xóa {before - len(df)} dòng. Còn {len(df)}.")


# ── XỬ LÝ 2: FULL_NAME — Title Case tiếng Việt ──────────────────
# title_case_vi() hỗ trợ Unicode — không dùng str.title() hay \b\w
df["_name_clean"] = df["full_name"].apply(title_case_vi)
changed = df["full_name"].fillna("") != df["_name_clean"]
for idx in df[changed].index:
    log.append(make_log(idx+2, "full_name",
                        df.loc[idx,"full_name"], df.loc[idx,"_name_clean"],
                        "NAME_NORMALIZED"))
df["full_name"] = df["_name_clean"]
df = df.drop(columns=["_name_clean"])
print(f"[full_name] Chuẩn hoá: {changed.sum()} dòng")


# ── XỬ LÝ 3: GENDER — Chuẩn hoá 9 cách viết → Nam/Nữ ───────────
df["_gender_clean"] = df["gender"].apply(normalize_gender)
changed = df["gender"].fillna("") != df["_gender_clean"]
for idx in df[changed].index:
    log.append(make_log(idx+2, "gender",
                        df.loc[idx,"gender"], df.loc[idx,"_gender_clean"],
                        "GENDER_NORMALIZED"))
df["gender"] = df["_gender_clean"]
df = df.drop(columns=["_gender_clean"])
print(f"[gender] Chuẩn hoá: {changed.sum()} dòng → {sorted(df['gender'].unique())}")


# ── XỬ LÝ 4: AGE — Validate 18–65, tính lại từ birth_year ──────
# birth_year đáng tin hơn age: người ta nhớ năm sinh rõ hơn tuổi
age_num = pd.to_numeric(df["age"], errors="coerce")
age_invalid = (age_num < 18) | (age_num > 65) | age_num.isnull()

for idx in df[age_invalid].index:
    birth = df.loc[idx, "birth_year"]
    new_age = 2024 - int(birth) if pd.notna(birth) else None
    log.append(make_log(idx+2, "age", df.loc[idx,"age"], new_age, "AGE_RECALCULATED"))
    flagged.append(make_flag(
        df.loc[idx,"emp_id"], df.loc[idx,"full_name"],
        "AGE_RECALCULATED", "age", df.loc[idx,"age"],
        "Age bất thường, đã tính lại từ birth_year — cần xác nhận"
    ))
    df.loc[idx, "age"] = new_age

df["age"] = pd.to_numeric(df["age"], errors="coerce")
print(f"[age] Tính lại từ birth_year: {age_invalid.sum()} dòng")


# ── XỬ LÝ 5: SALARY ─────────────────────────────────────────────
# NGUYÊN TẮC: Cleaning chỉ xử lý LỖI KỸ THUẬT rõ ràng (âm, null)
# KHÔNG sửa outlier — đó là việc của bước EDA/phân tích
#
# Lý do không sửa outlier:
#   761,285,602 có thể là lỗi nhập HOẶC CEO lương thực sự cao
#   HOẶC bonus ghi nhầm vào lương tháng
#   → Chỉ người sở hữu data mới biết → FLAG để họ quyết định
#   → EDA: vẽ boxplot, dùng IQR/z-score, rồi exclude hay winsorize tùy bài toán
#
# Lý do dùng null (không fill 0):
#   0 = khẳng định "nhân viên không có lương" (sai với thực tế)
#   null = thừa nhận "không biết lương đúng là bao nhiêu" (trung thực)
#   Khi phân tích: lọc IS NOT NULL trước khi tính trung bình lương

sal = pd.to_numeric(df["salary_k_vnd"], errors="coerce")

# Lỗi kỹ thuật: Âm → null
neg_mask = sal < 0
for idx in df[neg_mask].index:
    log.append(make_log(idx+2, "salary_k_vnd",
                        df.loc[idx,"salary_k_vnd"], None, "SALARY_NEGATIVE_NULLED"))
    flagged.append(make_flag(
        df.loc[idx,"emp_id"], df.loc[idx,"full_name"],
        "SALARY_ISSUE", "salary_vnd", df.loc[idx,"salary_k_vnd"],
        "Lương âm — đã set null, cần xác nhận giá trị đúng"
    ))
sal[neg_mask] = np.nan

# Lỗi kỹ thuật: Rỗng/NaN → null (giữ nguyên NaN, không fill)
null_mask = sal.isnull() & ~neg_mask  # null từ đầu (không phải từ bước trên)
for idx in df[null_mask].index:
    log.append(make_log(idx+2, "salary_k_vnd", "", None, "SALARY_NULL_KEPT"))
    flagged.append(make_flag(
        df.loc[idx,"emp_id"], df.loc[idx,"full_name"],
        "SALARY_ISSUE", "salary_vnd", None,
        "Lương trống — null, cần xác nhận giá trị đúng"
    ))

# Outlier: > 10 triệu → FLAG, KHÔNG sửa giá trị
outlier_mask = sal > 10_000_000
for idx in df[outlier_mask].index:
    # Không ghi logEntries vì giá trị KHÔNG thay đổi
    flagged.append(make_flag(
        df.loc[idx,"emp_id"], df.loc[idx,"full_name"],
        "SALARY_ISSUE", "salary_vnd", df.loc[idx,"salary_k_vnd"],
        "Lương bất thường cao (> 10 triệu) — outlier, cần xem xét ở bước EDA"
    ))

df["salary_k_vnd"] = sal
print(f"[salary] Âm → null: {neg_mask.sum()} | Null: {null_mask.sum()} | Outlier flag: {outlier_mask.sum()}")


# ── XỬ LÝ 6: EDUCATION — Chuẩn hoá tên trình độ ────────────────
df["_edu_clean"] = df["education"].apply(normalize_education)
changed = df["education"].fillna("") != df["_edu_clean"]
for idx in df[changed].index:
    log.append(make_log(idx+2, "education",
                        df.loc[idx,"education"], df.loc[idx,"_edu_clean"],
                        "EDU_NORMALIZED"))
df["education"] = df["_edu_clean"]
df = df.drop(columns=["_edu_clean"])
print(f"[education] Chuẩn hoá: {changed.sum()} dòng")


# ── XỬ LÝ 7: PERF_SCORE — Validate thang 1–5, fill median ──────
# Tại sao fill median thay vì drop dòng?
# → Mỗi dòng = 1 nhân viên thực, không bỏ vì 1 cột lỗi
# Pandas không có vấn đề parse "2.0" thành Date như GAS → đơn giản hơn
perf = pd.to_numeric(df["perf_score"], errors="coerce")
perf_valid   = perf[perf.between(1, 5)]
median_perf  = perf_valid.median() if len(perf_valid) > 0 else 3.0

# Tính median TRƯỚC khi fill — đảm bảo không bị ảnh hưởng bởi giá trị lỗi
perf_invalid = ~perf.between(1, 5)  # gồm cả NaN
for idx in df[perf_invalid].index:
    log.append(make_log(idx+2, "perf_score",
                        df.loc[idx,"perf_score"], median_perf, "PERF_FILLED_MEDIAN"))
df["perf_score"] = perf.where(perf.between(1, 5), median_perf)
# where(condition, other): giữ nguyên nếu condition=True, thay bằng other nếu False
print(f"[perf_score] Fill median ({median_perf}): {perf_invalid.sum()} dòng")


# ── XỬ LÝ 8: LEAVE_DAYS — Validate range 0–30 ──────────────────
ld = pd.to_numeric(df["leave_days"], errors="coerce")
ld_invalid = (ld < 0) | (ld > 30) | ld.isnull()
for idx in df[ld_invalid].index:
    action = "LEAVE_DAYS_CAPPED" if not pd.isnull(ld[idx]) else "FILLED_NULL"
    log.append(make_log(idx+2, "leave_days", df.loc[idx,"leave_days"], 0, action))
df["leave_days"] = ld.where(ld.between(0, 30), 0).fillna(0).astype(int)
print(f"[leave_days] Cap về 0: {ld_invalid.sum()} dòng")


# ── XỬ LÝ 9: HIRE_DATE — Parse nhiều format, chuẩn hoá ─────────
# Khác Sales: parse thất bại → giữ nguyên NaT, KHÔNG drop dòng
# Mỗi dòng = 1 nhân viên, không xóa vì 1 cột lỗi
parsed_results = df["hire_date"].apply(parse_vi_date)
hire_dates     = parsed_results.apply(lambda x: x[0])
hire_inferred  = parsed_results.apply(lambda x: x[1])

# Ghi log DATE_FORMAT_INFERRED (suy luận MM/DD)
for idx in df[hire_inferred].index:
    log.append(make_log(idx+2, "hire_date",
                        df.loc[idx,"hire_date"],
                        str(hire_dates[idx])[:10],
                        "DATE_FORMAT_INFERRED"))

# Ghi log DATE_NORMALIZED (format thay đổi nhưng không phải suy luận)
format_changed = (~hire_inferred) & hire_dates.notna()
for idx in df[format_changed].index:
    orig = str(df.loc[idx,"hire_date"])
    new  = str(hire_dates[idx])[:10]
    if orig != new:
        log.append(make_log(idx+2, "hire_date", orig, new, "DATE_NORMALIZED"))

df["hire_date"] = hire_dates  # NaT nếu parse thất bại — giữ nguyên
print(f"[hire_date] Suy luận MM/DD: {hire_inferred.sum()} | "
      f"Parse lỗi (giữ NaT): {hire_dates.isnull().sum()}")


# ── XỬ LÝ 10: EMAIL — 3 tình huống ─────────────────────────────
# [A] Có @ + có dấu tiếng Việt → bỏ dấu phần local
# [B] Thiếu @ + nhận ra domain → chèn @ + bỏ dấu local
# [C] Thiếu @ + không nhận ra domain → flag, không sửa
# Null → flag EMAIL_NULL

def clean_email(val):
    """
    Làm sạch 1 email — trả về (email_clean, email_valid, action | None)
    """
    if pd.isnull(val) or str(val).strip() == "":
        return val, False, "EMAIL_NULL"

    raw = str(val).strip()

    if "@" in raw:
        # [A] Có @ → kiểm tra dấu tiếng Việt trong phần local
        at_idx     = raw.index("@")
        local      = raw[:at_idx]       # phần trước @
        domain     = raw[at_idx:]       # @ + domain
        local_clean = remove_diacritics(local)

        if local != local_clean:
            # Có dấu → bỏ dấu phần local, giữ nguyên domain
            return local_clean + domain, True, "EMAIL_DIACRITIC_REMOVED"
        return raw, True, None  # None = không có thay đổi, không ghi log

    else:
        # Thiếu @ → thử tìm domain
        fixed = fix_missing_at(raw)
        if fixed:
            # [B] Nhận ra domain → đã sửa
            return fixed, True, "EMAIL_AT_INSERTED"
        else:
            # [C] Không nhận ra → flag, giữ nguyên
            return raw, False, "EMAIL_BROKEN"

# Áp dụng clean_email cho từng dòng
email_results = df["email"].apply(clean_email)
email_clean   = email_results.apply(lambda x: x[0])
email_valid   = email_results.apply(lambda x: x[1])
email_action  = email_results.apply(lambda x: x[2])

# Ghi log và flag cho từng dòng có thay đổi hoặc vấn đề
for idx in df.index:
    action = email_action[idx]
    if action is None:
        continue  # không thay đổi → không ghi log
    log.append(make_log(idx+2, "email", df.loc[idx,"email"], email_clean[idx], action))
    if not email_valid[idx]:
        # Email không hợp lệ → ghi vào flagged để review
        flagged.append(make_flag(
            df.loc[idx,"emp_id"], df.loc[idx,"full_name"],
            "EMAIL_INVALID", "email", email_clean[idx],
            "Email không hợp lệ hoặc trống — cần xác nhận và cập nhật"
        ))

df["email"] = email_clean
print(f"[email] "
      f"Bỏ dấu: {(email_action=='EMAIL_DIACRITIC_REMOVED').sum()} | "
      f"Thêm @: {(email_action=='EMAIL_AT_INSERTED').sum()} | "
      f"Broken: {(email_action=='EMAIL_BROKEN').sum()} | "
      f"Null: {(email_action=='EMAIL_NULL').sum()}")


# ── CROSS-COLUMN: hire_date × birth_year ────────────────────────
# Kiểm tra: năm vào làm có trước năm sinh không?
# Đây là mâu thuẫn logic tuyệt đối — không cần ngưỡng, không cần context
#
# Tại sao không check "tuổi vào làm < 18"?
#   → "hire_date trước birth_year" chắc chắn 100% là lỗi dữ liệu
#   → "tuổi vào làm < 18" có thể là thực ở một số trường hợp
#     → cần business context → để EDA quyết định
#
# Không sửa cột nào — không biết hire_date hay birth_year sai
# → Chỉ FLAG để người review xác nhận

hire_years  = df["hire_date"].dt.year   # NaT → NaN
birth_years = pd.to_numeric(df["birth_year"], errors="coerce")

# So sánh: hire_year <= birth_year → bất khả thi
cross_mask = (hire_years <= birth_years) & hire_years.notna() & birth_years.notna()
for idx in df[cross_mask].index:
    hy = int(hire_years[idx])
    by = int(birth_years[idx])
    # Ghi vào log với tên cặp cột để phân biệt với lỗi đơn cột
    log.append(make_log(
        idx+2,
        "hire_date × birth_year",  # tên cặp cột — dấu hiệu cross-column check
        f"hire_year={hy}",
        f"birth_year={by}",
        "HIRE_BEFORE_BIRTH"
    ))
    flagged.append(make_flag(
        df.loc[idx,"emp_id"], df.loc[idx,"full_name"],
        "HIRE_BEFORE_BIRTH",
        "hire_date × birth_year",
        f"hire={hy}, born={by}",
        f"Năm vào làm ({hy}) ≤ năm sinh ({by}) — bất khả thi, "
        f"cần xác nhận lại hire_date hoặc birth_year"
    ))
print(f"[cross-column] hire_date trước birth_year: {cross_mask.sum()} dòng → FLAG")


# ── DERIVED COLUMNS — Tính cột phái sinh hữu ích ────────────────
# tenure_years: số năm làm việc đến 2024-01-01
# Hữu ích hơn hire_date thô khi phân tích phân bổ kinh nghiệm
ref_date = pd.Timestamp("2024-01-01")
df["tenure_years"] = ((ref_date - df["hire_date"]).dt.days / 365).round(1)
# NaT hire_date → NaT tenure_years (không cố fill)

# Đổi tên salary_k_vnd → salary_vnd trong output
# Lý do: tên gốc không đúng, giá trị thực là VND không phải nghìn đồng
df = df.rename(columns={"salary_k_vnd": "salary_vnd"})


# ═════════════════════════════════════════════════════════════════
# BƯỚC 6 — VALIDATE
# ═════════════════════════════════════════════════════════════════

print("\n" + "=" * 60)
print("BƯỚC 6 — VALIDATE")
print("=" * 60)

assert df.duplicated().sum() == 0, \
    "❌ Còn duplicate!"
assert df["age"].dropna().between(18, 65).all(), \
    "❌ Age out of range!"
assert df["perf_score"].between(1, 5).all(), \
    "❌ perf_score out of range!"
assert df["gender"].isin(["Nam","Nữ","Không xác định"]).all(), \
    "❌ Gender không chuẩn!"
assert df["leave_days"].between(0, 30).all(), \
    "❌ leave_days out of range!"
# salary_vnd có thể null (lương âm/trống đã set null) → không assert >= 0
assert (df["salary_vnd"].dropna() >= 0).all(), \
    "❌ salary_vnd âm!"
print("✅ Tất cả assert passed!")

# Tóm tắt flag cần review
df_flag = pd.DataFrame(flagged)
if not df_flag.empty:
    print(f"\n⚠️  Cần review trong hr_flagged.csv:")
    print(df_flag["flag_type"].value_counts().to_string())

print(f"\nRows     : {df_raw.shape[0]} → {len(df)}")
print(f"Columns  : {df_raw.shape[1]} → {len(df.columns)}")
print(f"Log      : {len(log)} entries")
print(f"Flagged  : {len(flagged)} rows")


# ═════════════════════════════════════════════════════════════════
# BƯỚC 7 — EXPORT
# ═════════════════════════════════════════════════════════════════

# Sắp xếp cột: DATA_COLS (đã đổi tên salary) + derived
col_order = (
    [c if c != "salary_k_vnd" else "salary_vnd" for c in DATA_COLS]
    + ["tenure_years"]
)
df = df[col_order]

df.to_csv("data/clean/hr_clean.csv", index=False, encoding="utf-8")
print("\n✅ Đã lưu: data/clean/hr_clean.csv")

if log:
    pd.DataFrame(log).to_csv("data/clean/hr_cleaning_log.csv",
                              index=False, encoding="utf-8")
    print("✅ Đã lưu: data/clean/hr_cleaning_log.csv")

if flagged:
    pd.DataFrame(flagged).to_csv("data/clean/hr_flagged.csv",
                                 index=False, encoding="utf-8")
    print("✅ Đã lưu: data/clean/hr_flagged.csv")
