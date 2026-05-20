# =============================================================================
# SALES DATA CLEANING — Python / pandas
# Dataset : sales_dirty.csv  (~300 rows)
# Đồng bộ logic với: google-apps-script/01_sales_cleaning_v2.gs
# =============================================================================

import pandas as pd
import numpy as np
import re


# ═════════════════════════════════════════════════════════════════
# HELPER FUNCTIONS
# ═════════════════════════════════════════════════════════════════

def parse_vi_date(s):
    """
    Parse chuỗi ngày Việt Nam, trả về (Timestamp | NaT, inferred: bool).

    Thứ tự thử:
      1. YYYY-MM-DD  → rõ ràng nhất
      2. DD/MM/YYYY  → chuẩn Việt Nam
      3. DD-MM-YYYY  → Việt Nam dấu gạch
      4. DD/MM/YY    → năm 2 chữ số
      5. MM/DD/YYYY  → suy luận khi p2 > 12 (không thể là tháng)

    inferred=True khi dùng logic suy luận bước 5 — ghi log riêng để review.
    """
    if pd.isnull(s) or str(s).strip() == "":
        return pd.NaT, False

    s = str(s).strip()

    # Format 1: YYYY-MM-DD
    try:
        return pd.to_datetime(s, format="%Y-%m-%d"), False
    except ValueError:
        pass

    # Format 2 & 3: DD/MM/YYYY hoặc DD-MM-YYYY
    m = re.match(r'^(\d{2})[/\-](\d{2})[/\-](\d{4})$', s)
    if m:
        p1, p2, year = int(m.group(1)), int(m.group(2)), int(m.group(3))

        # Bước 1: thử DD/MM (chuẩn Việt Nam)
        if 1 <= p2 <= 12 and 1 <= p1 <= 31:
            try:
                return pd.to_datetime(f"{year}-{p2:02d}-{p1:02d}", format="%Y-%m-%d"), False
            except ValueError:
                pass  # VD: 31/02 → không tồn tại → thử suy luận

        # Bước 2: suy luận MM/DD nếu p2 > 12 (p2 không thể là tháng)
        # Ví dụ "02/22/2024": p2=22 > 12 → p1=2 (tháng), p2=22 (ngày)
        if 1 <= p1 <= 12 and 1 <= p2 <= 31:
            try:
                return pd.to_datetime(f"{year}-{p1:02d}-{p2:02d}", format="%Y-%m-%d"), True
            except ValueError:
                pass

        return pd.NaT, False

    # Format 4: DD/MM/YY (năm 2 chữ số)
    m = re.match(r'^(\d{2})/(\d{2})/(\d{2})$', s)
    if m:
        p1, p2, yy = int(m.group(1)), int(m.group(2)), int(m.group(3))
        year = 1900 + yy if yy > 50 else 2000 + yy
        if 1 <= p2 <= 12 and 1 <= p1 <= 31:
            try:
                return pd.to_datetime(f"{year}-{p2:02d}-{p1:02d}", format="%Y-%m-%d"), False
            except ValueError:
                pass

    return pd.NaT, False


def normalize_region(val):
    """Chuẩn hoá tên tỉnh/thành về dạng chuẩn qua bảng mapping."""
    if pd.isnull(val):
        return "Không xác định"
    region_map = {
        "hn": "Hà Nội", "ha noi": "Hà Nội", "hà nội": "Hà Nội",
        "hcm": "Hồ Chí Minh", "ho chi minh": "Hồ Chí Minh",
        "sg": "Hồ Chí Minh", "sài gòn": "Hồ Chí Minh", "sai gon": "Hồ Chí Minh",
        "da nang": "Đà Nẵng", "dn": "Đà Nẵng", "đà nẵng": "Đà Nẵng",
        "hp": "Hải Phòng", "hai phong": "Hải Phòng", "hải phòng": "Hải Phòng",
    }
    key = str(val).strip().lower()
    return region_map.get(key, str(val).strip() or "Không xác định")


# Bảng mapping tên nhân viên: gộp các cách viết không dấu / sai về tên chuẩn có dấu
# Cần mapping thủ công vì title_case_vi() không thể tự thêm dấu tiếng Việt
# Key: lowercase không dấu (hoặc sai dạng), Value: tên chuẩn đầy đủ dấu
SALESPERSON_MAP = {
    "le minh cuong":   "Lê Minh Cường",   # không dấu → có dấu
    "le minh cường":   "Lê Minh Cường",   # thiếu một số dấu
    "nguyen van an":   "Nguyễn Văn An",
    "tran thi binh":   "Trần Thị Bình",
    "pham thi dung":   "Phạm Thị Dung",
    "hoang van em":    "Hoàng Văn Em",
}

def title_case_vi(s):
    """
    Chuẩn hoá tên nhân viên — 2 bước:
      Bước 1: Tra SALESPERSON_MAP trước (lowercase key)
              → xử lý tên không dấu / sai dấu như "Le Minh Cuong" → "Lê Minh Cường"
      Bước 2: Nếu không có trong map → title case thông thường
              → xử lý ALL CAPS, lowercase bình thường

    Tại sao cần map thủ công?
      title_case_vi() chỉ viết hoa chữ đầu, không thể tự thêm dấu tiếng Việt.
      "le minh cuong".capitalize() → "Le minh cuong" (vẫn thiếu dấu)
      → Phải map tường minh: "le minh cuong" → "Lê Minh Cường"
    """
    if pd.isnull(s) or str(s).strip() == "":
        return "Không xác định"

    # Bước 1: tra map theo lowercase — bắt được "LE MINH CUONG", "le minh cuong", "Le Minh Cuong"
    key = str(s).strip().lower()
    if key in SALESPERSON_MAP:
        return SALESPERSON_MAP[key]

    # Bước 2: không có trong map → title case thông thường
    return " ".join(word.capitalize() for word in str(s).strip().lower().split())


# ═════════════════════════════════════════════════════════════════
# ĐỌC DỮ LIỆU
# ═════════════════════════════════════════════════════════════════

# usecols giới hạn đúng 10 cột schema — bỏ qua cột ghi chú thừa nếu có
DATA_COLS = ["order_id","date","customer_id","product","amount",
             "region","salesperson","status","quantity","discount_pct"]

df_raw = pd.read_csv("data/raw/sales_dirty.csv", usecols=DATA_COLS)
df     = df_raw.copy()   # KHÔNG BAO GIỜ sửa trực tiếp df_raw

# Khởi tạo cleaning log — cùng cấu trúc với Cleaning_Log sheet trong GAS
# Mỗi entry có đủ 5 trường: row_original, field, old_value, new_value, action
# row_original = số thứ tự hàng trong file gốc (bắt đầu từ 2, hàng 1 là header)
# → giống hệt cột "row_original" trong GAS log, để 2 log có thể đối chiếu nhau
log = []  # list of dict, export thành CSV ở cuối

# Helper: tạo log entry chuẩn — dùng thống nhất trong toàn file
def make_log(row_num, field, old_val, new_val, action):
    return {"row_original": row_num, "field": field,
            "old_value": old_val, "new_value": new_val, "action": action}


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
print(miss[miss["count"] > 0])


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
print(f"[Date]        Mẫu 10 dòng đầu: {df['date'].head(10).tolist()}")
print(f"[Region]      {df['region'].nunique(dropna=False)} unique values:")
print(df["region"].value_counts(dropna=False).to_string())
amt_num = pd.to_numeric(df["amount"], errors="coerce")
print(f"\n[Amount]      Âm + không returned : {((amt_num<0) & (df['status']!='returned')).sum()}")
print(f"[Amount]      Dương + returned     : {((amt_num>0) & (df['status']=='returned')).sum()}")
print(f"[Amount]      < 100,000 + không returned (nghi nhầm đơn vị): {((amt_num>0) & (amt_num<100_000) & (df['status']!='returned')).sum()}")
print(f"\n[Salesperson] unique: {df['salesperson'].nunique(dropna=False)}")
print(df["salesperson"].value_counts(dropna=False).head(10).to_string())


# ═════════════════════════════════════════════════════════════════
# BƯỚC 5 — LÀM SẠCH
# ═════════════════════════════════════════════════════════════════

print("\n" + "=" * 60)
print("BƯỚC 5 — LÀM SẠCH")
print("=" * 60)


# Theo dõi row_original — số thứ tự hàng trong df_raw (bắt đầu từ 2 như GAS)
# Index của df_raw tương ứng với hàng trong file gốc
# Sau drop_duplicates, index gốc được giữ nguyên → dùng để ghi row_original chính xác

# ── XỬ LÝ 1: DUPLICATE ──────────────────────────────────────────
# Giữ index gốc (row number trong file) để ghi log chính xác
before = len(df)
# Tìm các dòng trùng TRƯỚC khi drop để lấy row_original
dup_mask = df.duplicated(keep="first")
for idx in df[dup_mask].index:
    # idx+2: +1 vì index bắt đầu từ 0 (hàng dữ liệu đầu), +1 vì hàng 1 là header
    log.append(make_log(idx+2, "order_id", df.loc[idx,"order_id"], "", "DROPPED_DUPLICATE"))

df = df.drop_duplicates(keep="first")
n_dupes = before - len(df)
print(f"[Duplicate] Xóa {n_dupes} dòng. Còn {len(df)}.")


# ── XỬ LÝ 2: DATE ───────────────────────────────────────────────
# parse_vi_date trả về (Timestamp, inferred) → dùng apply rồi unzip
parsed_results   = df["date"].apply(parse_vi_date)
df["date"]       = parsed_results.apply(lambda x: x[0])
inferred_mask    = parsed_results.apply(lambda x: x[1])

# Ghi log DATE_FORMAT_INFERRED
for idx in df[inferred_mask].index:
    log.append(make_log(idx+2, "date", df_raw.loc[idx,"date"],
                        str(df.loc[idx,"date"])[:10], "DATE_FORMAT_INFERRED"))
print(f"[Date] Suy luận MM/DD: {inferred_mask.sum()} dòng")

# Ghi log và drop dòng không parse được
bad_mask = df["date"].isnull()
for idx in df[bad_mask].index:
    log.append(make_log(idx+2, "date", df_raw.loc[idx,"date"], "PARSE_ERROR", "DROPPED_ROW"))
df = df.dropna(subset=["date"])
print(f"[Date] Parse lỗi → drop: {bad_mask.sum()} dòng. Còn {len(df)}.")

# Chuẩn hoá sang string YYYY-MM-DD để export nhất quán
df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")


# ── XỬ LÝ 3: REGION ─────────────────────────────────────────────
# Giữ cột region gốc để audit, tạo clean_region mới để phân tích
df["clean_region"] = df["region"].apply(normalize_region)
changed = df["region"] != df["clean_region"]
for idx in df[changed].index:
    log.append(make_log(idx+2, "region", df.loc[idx,"region"],
                        df.loc[idx,"clean_region"], "REGION_NORMALIZED"))
print(f"[Region] Chuẩn hoá: {changed.sum()} dòng → {sorted(df['clean_region'].unique())}")


# ── XỬ LÝ 4: SALESPERSON ────────────────────────────────────────
# title_case_vi() xử lý đúng Unicode, không dùng str.title()
df["_sp_clean"] = df["salesperson"].apply(title_case_vi)
sp_changed = df["salesperson"].fillna("") != df["_sp_clean"]
for idx in df[sp_changed].index:
    log.append(make_log(idx+2, "salesperson", df.loc[idx,"salesperson"],
                        df.loc[idx,"_sp_clean"], "NAME_NORMALIZED"))
df["salesperson"] = df["_sp_clean"]
df = df.drop(columns=["_sp_clean"])
print(f"[Salesperson] Chuẩn hoá: {sp_changed.sum()} dòng")


# ── XỬ LÝ 5: CROSS-COLUMN VALIDATION — amount × status ──────────
#
# Không kiểm tra từng cột riêng — kiểm tra SỰ NHẤT QUÁN giữa 2 cột.
# Từng cột riêng "hợp lệ" nhưng ghép lại có thể mâu thuẫn.
#
# [A] amount > 0  + không returned → Nhất quán, không làm gì
# [B] amount < 0  + returned       → Hợp lệ, FLAG nhẹ
# [C] amount < 0  + không returned → Mâu thuẫn rõ, FLAG để review
# [D] amount > 0  + returned       → Nghi ngờ convention, FLAG
# [E] 0 < amount < 1,000,000 + không returned → nhầm đơn vị → nhân 1000

df["amount"] = pd.to_numeric(df["amount"], errors="coerce").round().astype("Int64")
is_ret = df["status"].str.lower() == "returned"

# [C] Mâu thuẫn: âm + không returned — GIỮ + FLAG (không drop)
mask_c = (df["amount"] < 0) & (~is_ret)
for idx in df[mask_c].index:
    log.append(make_log(idx+2, "amount", int(df.loc[idx,"amount"]),
                        int(df.loc[idx,"amount"]), "AMOUNT_STATUS_CONFLICT"))
print(f"[Amount] Mâu thuẫn (âm + không returned): {mask_c.sum()} → FLAG")

# [B] Âm + returned — hợp lệ nhưng FLAG
mask_b = (df["amount"] < 0) & is_ret
for idx in df[mask_b].index:
    log.append(make_log(idx+2, "amount", int(df.loc[idx,"amount"]),
                        int(df.loc[idx,"amount"]), "AMOUNT_NEGATIVE_RETURNED"))
print(f"[Amount] Âm + returned: {mask_b.sum()} → FLAG")

# [D] Dương + returned — nghi ngờ
mask_d = (df["amount"] > 0) & is_ret
for idx in df[mask_d].index:
    log.append(make_log(idx+2, "amount", int(df.loc[idx,"amount"]),
                        int(df.loc[idx,"amount"]), "AMOUNT_POSITIVE_RETURNED"))
print(f"[Amount] Dương + returned: {mask_d.sum()} → FLAG")

# [E] Nhầm đơn vị → nhân 1000
# Ngưỡng 100,000 VND: dữ liệu lỗi thực tế là string bị convert thành số nhỏ < 100,000
# Không dùng 1,000,000 vì sản phẩm hợp lệ (Mouse Wireless × 2 = 900,000) bị nhân nhầm
# Ví dụ lỗi: "7.8" → 7 (mất đơn vị khi parse) → < 100,000 → nhân 1000 → 7,000 (vẫn sai)
# → Cần kết hợp thêm điều kiện: amount < 100,000 chắc chắn là lỗi, không thể là giá hợp lệ
mask_e = (df["amount"] > 0) & (df["amount"] < 100_000) & (~is_ret)
for idx in df[mask_e].index:
    old = int(df.loc[idx,"amount"])
    log.append(make_log(idx+2, "amount", old, old*1000, "AMOUNT_UNIT_FIXED"))
df.loc[mask_e, "amount"] = df.loc[mask_e, "amount"] * 1000
print(f"[Amount] Nhầm đơn vị → nhân 1000: {mask_e.sum()} dòng")


# ── XỬ LÝ 6: CUSTOMER_ID ────────────────────────────────────────
null_cust = df["customer_id"].isnull()
for idx in df[null_cust].index:
    log.append(make_log(idx+2, "customer_id", "", "UNKNOWN", "FILLED_NULL"))
df["customer_id"] = df["customer_id"].fillna("UNKNOWN")
print(f"[Customer ID] Fill null: {null_cust.sum()} dòng")


# ── XỬ LÝ 7: DISCOUNT_PCT ───────────────────────────────────────
null_disc = df["discount_pct"].isnull()
for idx in df[null_disc].index:
    log.append(make_log(idx+2, "discount_pct", "", 0, "FILLED_NULL"))
df["discount_pct"] = df["discount_pct"].fillna(0)
print(f"[Discount] Fill null: {null_disc.sum()} dòng")


# ── DERIVED COLUMNS ──────────────────────────────────────────────
df["month"]   = pd.to_datetime(df["date"]).dt.month
df["quarter"] = pd.to_datetime(df["date"]).dt.quarter
df["amount_after_discount"] = (
    pd.to_numeric(df["amount"], errors="coerce") * (1 - df["discount_pct"] / 100)
).round().astype("Int64")


# ═════════════════════════════════════════════════════════════════
# BƯỚC 6 — VALIDATE
# ═════════════════════════════════════════════════════════════════

print("\n" + "=" * 60)
print("BƯỚC 6 — VALIDATE")
print("=" * 60)

assert df.duplicated().sum() == 0,               "❌ Còn duplicate!"
assert df["date"].isnull().sum() == 0,           "❌ Còn date null!"
assert df["discount_pct"].between(0,100).all(),  "❌ discount_pct out of range!"
assert df["clean_region"].isnull().sum() == 0,   "❌ clean_region có null!"
assert df["month"].between(1, 12).all(),         "❌ month out of range!"
assert df["quarter"].between(1, 4).all(),        "❌ quarter out of range!"
print("✅ Tất cả assert passed!")

# Tóm tắt flags cần review
df_log = pd.DataFrame(log)
FLAG_ACTIONS = ["AMOUNT_STATUS_CONFLICT","AMOUNT_NEGATIVE_RETURNED",
                "AMOUNT_POSITIVE_RETURNED","AMOUNT_UNIT_FIXED"]
if not df_log.empty:
    flags = df_log[df_log["action"].isin(FLAG_ACTIONS)]["action"].value_counts()
    if not flags.empty:
        print(f"\n⚠️  Cần review (xem sales_cleaning_log.csv):")
        print(flags.to_string())

print(f"\nRows    : {df_raw.shape[0]} → {len(df)}")
print(f"Columns : {df_raw.shape[1]} → {len(df.columns)}")
print(f"Log entries: {len(log)}")


# ═════════════════════════════════════════════════════════════════
# BƯỚC 7 — EXPORT
# ═════════════════════════════════════════════════════════════════

# Sắp xếp cột — đồng bộ với GAS: 10 cột gốc + 4 derived theo đúng thứ tự GAS
# GAS extraCols = ["month", "quarter", "amount_after_discount", "clean_region"]
col_order = DATA_COLS + ["month","quarter","amount_after_discount","clean_region"]
df = df[col_order]

df.to_csv("data/clean/project-01-sales/sales_clean.csv", index=False, encoding="utf-8")
print("\n✅ Đã lưu: data/project-01-sales/clean/sales_clean.csv")

if log:
    df_log.to_csv("data/clean/project-01-sales/sales_cleaning_log.csv", index=False, encoding="utf-8")
    print("✅ Đã lưu: data/clean/project-01-sales/sales_cleaning_log.csv")
