# =============================================================================
# PROJECT 03 — E-COMMERCE DATA CLEANING
# =============================================================================
# Dataset : customers_dirty.csv · products_dirty.csv · orders_dirty.csv
# Tools   : Python · pandas · json · re
# Logic đồng bộ với: google-apps-script/project-03-ecommerce/
#
# OUTPUT:
#   data/clean/project-03-ecommerce/customers_clean.csv
#   data/clean/project-03-ecommerce/products_clean.csv
#   data/clean/project-03-ecommerce/orders_clean.csv
#   data/clean/project-03-ecommerce/ecommerce_cleaning_log.csv
#   data/clean/project-03-ecommerce/ecommerce_flagged.csv
# =============================================================================


# ══════════════════════════════════════════════════════════════════════
# PHẦN 1 — HELPER FUNCTIONS
# ══════════════════════════════════════════════════════════════════════

# ## Phần 1 — Helper Functions
# Khai báo trước, dùng trong toàn notebook.
# Logic đồng bộ 1-1 với các helper trong GAS.
import pandas as pd
import numpy as np
import json, re
from datetime import datetime

# ── HELPER: Bỏ dấu tiếng Việt → ASCII ─────────────────────────────
# Dùng để chuẩn hoá phần local của email
def remove_diacritics(s):
    if not s: return s
    diac = str.maketrans(
        "àáảãạăắặằẳẵâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ"
        "ÀÁẢÃẠĂẮẶẰẲẴÂẤẦẨẪẬĐÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴ",
        "aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy"
        "aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy"
    )
    return str(s).lower().translate(diac)

# ── HELPER: Thêm @ vào email thiếu ────────────────────────────────
# Domain dài → ngắn để tránh match nhầm
def fix_missing_at(email):
    domains = ["outlook.com", "company.vn", "gmail.com", "yahoo.com"]
    lower = email.lower()
    for d in domains:
        idx = lower.find(d)
        if idx > 0:
            return remove_diacritics(email[:idx]) + "@" + email[idx:]
    return None

# ── HELPER: Clean 1 email ──────────────────────────────────────────
def clean_email(val):
    """Trả về (email_clean, valid, action|None)"""
    if pd.isnull(val) or not str(val).strip():
        return val, False, "EMAIL_NULL"
    raw = str(val).strip()
    if "@" in raw:
        at = raw.index("@")
        local, domain = raw[:at], raw[at:]
        clean_local = remove_diacritics(local)
        if local != clean_local:
            return clean_local + domain, True, "EMAIL_DIACRITIC_REMOVED"
        return raw, True, None
    fixed = fix_missing_at(raw)
    if fixed:
        return fixed, True, "EMAIL_AT_INSERTED"
    return raw, False, "EMAIL_BROKEN"

# ── HELPER: Chuẩn hoá phone Việt Nam về 10 số ─────────────────────
# Rule rõ ràng → tự sửa, không flag:
#   +84xxxxxxxxx (12 ký tự) → 0xxxxxxxxx
#   84xxxxxxxxx  (11 ký tự) → 0xxxxxxxxx
#   9 số bắt đầu [35789]    → thêm 0
def normalize_phone(val):
    """Trả về (phone_clean, action|None)"""
    if pd.isnull(val): return val, None
    raw = str(val).strip()
    p = re.sub(r'[\s\-\.]', '', raw)  # xóa dấu gạch, space, chấm

    if p.startswith("+84") and len(p) == 12:
        return "0" + p[3:], "PHONE_NORMALIZED"
    elif p.startswith("84") and len(p) == 11:
        return "0" + p[2:], "PHONE_NORMALIZED"
    elif re.match(r'^[35789]\d{8}$', p):
        # 9 số bắt đầu đầu số di động VN → thiếu 0
        return "0" + p, "PHONE_NORMALIZED"
    return p, None  # giữ nguyên (đã chuẩn hoặc không nhận ra)

# ── HELPER: Parse ngày Việt Nam ────────────────────────────────────
def parse_vi_date(s):
    """Trả về (Timestamp|NaT, inferred:bool)"""
    if pd.isnull(s) or str(s).strip() == "": return pd.NaT, False
    s = str(s).strip()

    # Format 1: YYYY-MM-DD
    try: return pd.to_datetime(s, format="%Y-%m-%d"), False
    except: pass

    # Format 2 & 3: DD/MM/YYYY hoặc D/M/YYYY (chấp nhận 1-2 chữ số ngày/tháng)
    # VD: "26/5/2023" hoặc "26/05/2023" đều được
    m = re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$', s)
    if m:
        p1, p2, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if 1 <= p2 <= 12 and 1 <= p1 <= 31:
            try: return pd.to_datetime(f"{y}-{p2:02d}-{p1:02d}", format="%Y-%m-%d"), False
            except: pass
        if 1 <= p1 <= 12 and 1 <= p2 <= 31:
            try: return pd.to_datetime(f"{y}-{p1:02d}-{p2:02d}", format="%Y-%m-%d"), True
            except: pass

    # Format 4: DD/MM/YY hoặc D/M/YY (năm 2 chữ số)
    # VD: "04/12/23" hoặc "4/12/23" → 2023-12-04
    m2 = re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2})$', s)
    if m2:
        p1, p2, yy = int(m2.group(1)), int(m2.group(2)), int(m2.group(3))
        y = 1900 + yy if yy > 50 else 2000 + yy
        if 1 <= p2 <= 12 and 1 <= p1 <= 31:
            try: return pd.to_datetime(f"{y}-{p2:02d}-{p1:02d}", format="%Y-%m-%d"), False
            except: pass

    return pd.NaT, False


# ── HELPER: Parse weight_kg an toàn ────────────────────────────────
# GAS gặp vấn đề Sheets parse "14.02" → Date object
# Python không gặp vấn đề này khi đọc CSV — pandas đọc thẳng string/float
# Nhưng vẫn cần xử lý dấu phẩy thập phân: "14,02" → 14.02
def parse_weight(val):
    """Trả về (weight:float|NaN, action|None)"""
    if pd.isnull(val): return np.nan, None
    s = str(val).strip().replace(",", ".")  # "14,02" → "14.02"
    try:
        w = float(s)
        return w, None
    except:
        return np.nan, "WEIGHT_UNPARSEABLE"

# ── HELPER: Parse shipping_address JSON ────────────────────────────
# [A] JSON hợp lệ → parse bình thường
# [B] Thiếu "}" → thêm vào → thử lại
# [C] Rỗng → fill "Không xác định"
def parse_address(val):
    """Trả về (street, district, city, action)"""
    na = "Không xác định"
    if pd.isnull(val) or str(val).strip() == "":
        return na, na, na, "ADDRESS_MISSING"
    raw = str(val).strip()
    # Thử parse trực tiếp
    try:
        d = json.loads(raw)
        return d.get("street", na), d.get("district", na), d.get("city", na), None
    except:
        pass
    # Thêm "}" nếu thiếu
    if raw.startswith("{") and not raw.endswith("}"):
        try:
            d = json.loads(raw + "}")
            return d.get("street", na), d.get("district", na), d.get("city", na), "ADDRESS_FIXED"
        except:
            pass
    return na, na, na, "ADDRESS_INVALID"

# ── HELPER: Tạo log/flag entry ─────────────────────────────────────
def make_log(table, row_id, field, old_val, new_val, action):
    return {"table":table, "row_id":row_id, "field":field,
            "old_value":old_val, "new_value":new_val, "action":action}

def make_flag(table, row_id, flag_type, field, value, note):
    return {"table":table, "row_id":row_id, "flag_type":flag_type,
            "field":field, "value":value, "note":note}

print("✅ Helpers loaded")


# ══════════════════════════════════════════════════════════════════════
# PHẦN 2 — ĐỌC & TỔNG QUAN
# ══════════════════════════════════════════════════════════════════════

# ## Phần 2 — Đọc & Tổng quan
# **Mục tiêu:** Hiểu hình dạng của 3 bảng trong 60 giây.
# Đọc 3 file raw
df_cus_raw = pd.read_csv("data/raw/customers_dirty.csv")
df_prd_raw = pd.read_csv("data/raw/products_dirty.csv")
df_ord_raw = pd.read_csv("data/raw/orders_dirty.csv")

for name, df in [("CUSTOMERS", df_cus_raw), ("PRODUCTS", df_prd_raw), ("ORDERS", df_ord_raw)]:
    print(f"{'='*50}")
    print(f"[{name}] Shape: {df.shape}")
    print(f"Columns: {list(df.columns)}")
    print(f"dtypes:\n{df.dtypes.to_string()}")
    print()

# Xem mẫu 3 dòng đầu
for name, df in [("CUSTOMERS", df_cus_raw), ("PRODUCTS", df_prd_raw), ("ORDERS", df_ord_raw)]:
    print(f"=== {name} ===")
    print(df.head(3).to_string())
    print()


# ══════════════════════════════════════════════════════════════════════
# PHẦN 3 — CHẨN ĐOÁN
# ══════════════════════════════════════════════════════════════════════

# ## Phần 3 — Chẩn đoán
# Lập danh sách đầy đủ vấn đề **trước** khi sửa bất cứ thứ gì.
# Missing values
for name, df in [("CUSTOMERS", df_cus_raw), ("PRODUCTS", df_prd_raw), ("ORDERS", df_ord_raw)]:
    miss = df.isnull().sum()
    print(f"[{name}] Missing:")
    print(miss[miss > 0].to_string() if miss.sum() > 0 else "  Không có null")
    print()

# Duplicate
for name, df, id_col in [
    ("CUSTOMERS", df_cus_raw, "customer_id"),
    ("PRODUCTS",  df_prd_raw, "product_id"),
    ("ORDERS",    df_ord_raw, "order_id"),
]:
    print(f"[{name}] Duplicate toàn dòng: {df.duplicated().sum()} | {id_col}: {df[id_col].duplicated().sum()}")

# Referential integrity — chỉ kiểm tra được khi có nhiều bảng
valid_cus = set(df_cus_raw["customer_id"])
valid_prd = set(df_prd_raw["product_id"])

inv_cus = df_ord_raw[~df_ord_raw["customer_id"].isin(valid_cus)]
inv_prd = df_ord_raw[~df_ord_raw["product_id"].isin(valid_prd)]
print(f"Orders có customer_id không tồn tại: {len(inv_cus)}")
print(f"Orders có product_id không tồn tại:  {len(inv_prd)}")

# Chẩn đoán các vấn đề đặc thù
print("=== CUSTOMERS ===")
print(f"membership_tier: {df_cus_raw['membership_tier'].value_counts(dropna=False).to_dict()}")
print(f"Email thiếu @:   {df_cus_raw['email'].dropna().apply(lambda x: '@' not in x).sum()}")
print(f"Phone 9 số:      {df_cus_raw['phone'].dropna().apply(lambda x: re.match(r'^[35789]\d{{8}}$', re.sub(r'[\s\-\.]','',str(x))) is not None).sum()}")

print("\n=== PRODUCTS ===")
print(f"price_vnd ≤ 0:   {(df_prd_raw['price_vnd'] <= 0).sum()}")
print(f"stock_qty âm:    {(df_prd_raw['stock_qty'] < 0).sum()}")
print(f"status unique:   {df_prd_raw['status'].value_counts(dropna=False).to_dict()}")
print(f"weight_kg mẫu:   {df_prd_raw['weight_kg'].head(5).tolist()}")

print("\n=== ORDERS ===")
print(f"Currency:        {df_ord_raw['currency'].value_counts().to_dict()}")
print(f"Address rỗng:    {(df_ord_raw['shipping_address'].fillna('') == '').sum()}")
broken_json = df_ord_raw['shipping_address'].dropna().apply(
    lambda x: bool(x) and not str(x).strip().endswith('}')
).sum()
print(f"JSON broken:     {broken_json}")
print(f"discount null:   {df_ord_raw['discount_pct'].isnull().sum()}")


# ══════════════════════════════════════════════════════════════════════
# PHẦN 4 — LÀM SẠCH CUSTOMERS
# ══════════════════════════════════════════════════════════════════════

# ## Phần 4 — Làm sạch Customers
# Xử lý 6 bước theo đúng thứ tự GAS.
cus = df_cus_raw.copy()
log, flagged = [], []

# BƯỚC 1: DUPLICATE
dup = cus.duplicated(keep="first")
for idx in cus[dup].index:
    log.append(make_log("customers", cus.loc[idx,"customer_id"], "customer_id",
                        cus.loc[idx,"customer_id"], "", "DROPPED_DUPLICATE"))
before = len(cus)
cus = cus.drop_duplicates(keep="first").reset_index(drop=True)
print(f"[1] Duplicate: xóa {before-len(cus)}")

# BƯỚC 2: FULL_NAME — title case tiếng Việt
def title_vi(s):
    if pd.isnull(s) or not str(s).strip(): return "Không xác định"
    return " ".join(w.capitalize() for w in str(s).strip().lower().split())

cus["_name"] = cus["full_name"].apply(title_vi)
changed = cus["full_name"].fillna("") != cus["_name"]
for idx in cus[changed].index:
    log.append(make_log("customers", cus.loc[idx,"customer_id"], "full_name",
                        cus.loc[idx,"full_name"], cus.loc[idx,"_name"], "NAME_NORMALIZED"))
cus["full_name"] = cus["_name"]
cus = cus.drop(columns=["_name"])
print(f"[2] full_name: chuẩn hoá {changed.sum()}")

# BƯỚC 3: EMAIL
res = cus["email"].apply(clean_email)
cus["email"] = res.apply(lambda x: x[0])
email_valid  = res.apply(lambda x: x[1])
email_action = res.apply(lambda x: x[2])
for idx in cus.index:
    if email_action[idx]:
        log.append(make_log("customers", cus.loc[idx,"customer_id"], "email",
                            df_cus_raw.loc[idx,"email"] if idx < len(df_cus_raw) else "",
                            cus.loc[idx,"email"], email_action[idx]))
    if not email_valid[idx]:
        flagged.append(make_flag("customers", cus.loc[idx,"customer_id"],
                                 "EMAIL_INVALID", "email", cus.loc[idx,"email"],
                                 "Email không hợp lệ — cần xác nhận"))
print(f"[3] email: bỏ dấu {(email_action=='EMAIL_DIACRITIC_REMOVED').sum()} | "
      f"thêm @ {(email_action=='EMAIL_AT_INSERTED').sum()} | "
      f"broken {(email_action=='EMAIL_BROKEN').sum()}")

# BƯỚC 4: PHONE — tự sửa các pattern rõ, chỉ flag khi thực sự không rõ
res_p = cus["phone"].apply(normalize_phone)
cus["phone"]  = res_p.apply(lambda x: x[0])
phone_action  = res_p.apply(lambda x: x[1])
for idx in cus.index:
    if phone_action[idx]:
        log.append(make_log("customers", cus.loc[idx,"customer_id"], "phone",
                            df_cus_raw.loc[idx,"phone"] if idx < len(df_cus_raw) else "",
                            cus.loc[idx,"phone"], "PHONE_NORMALIZED"))
# Flag chỉ khi không đúng format 10 số chuẩn
invalid_phone = ~cus["phone"].astype(str).str.match(r'^0[35789]\d{8}$')
for idx in cus[invalid_phone].index:
    flagged.append(make_flag("customers", cus.loc[idx,"customer_id"],
                             "PHONE_INVALID", "phone", cus.loc[idx,"phone"],
                             "Không nhận dạng được format — cần xác nhận thủ công"))
print(f"[4] phone: chuẩn hoá {phone_action.notna().sum()} | invalid flag {invalid_phone.sum()}")

# BƯỚC 5: MEMBERSHIP_TIER
tier_map = {"bronze":"Bronze","silver":"Silver","gold":"Gold","platinum":"Platinum"}
cus["_tier"] = cus["membership_tier"].apply(
    lambda x: tier_map.get(str(x).lower().strip(), str(x).strip() if pd.notna(x) else "Không xác định")
)
changed = cus["membership_tier"].fillna("") != cus["_tier"]
for idx in cus[changed].index:
    log.append(make_log("customers", cus.loc[idx,"customer_id"], "membership_tier",
                        cus.loc[idx,"membership_tier"], cus.loc[idx,"_tier"], "TIER_NORMALIZED"))
cus["membership_tier"] = cus["_tier"]
cus = cus.drop(columns=["_tier"])
print(f"[5] membership_tier: {cus['membership_tier'].value_counts().to_dict()}")

# BƯỚC 6: REGISTRATION_DATE
res_d = cus["registration_date"].apply(parse_vi_date)
cus["registration_date"] = res_d.apply(lambda x: x[0]).dt.strftime("%Y-%m-%d")
print(f"[6] registration_date: null còn {cus['registration_date'].isnull().sum()}")
print(f"\nCustomers: {len(df_cus_raw)} → {len(cus)} dòng")


# ══════════════════════════════════════════════════════════════════════
# PHẦN 5 — LÀM SẠCH PRODUCTS
# ══════════════════════════════════════════════════════════════════════

# ## Phần 5 — Làm sạch Products
prd = df_prd_raw.copy()

# BƯỚC 1: DUPLICATE
dup = prd.duplicated(keep="first")
for idx in prd[dup].index:
    log.append(make_log("products", prd.loc[idx,"product_id"], "product_id",
                        prd.loc[idx,"product_id"], "", "DROPPED_DUPLICATE"))
before = len(prd)
prd = prd.drop_duplicates(keep="first").reset_index(drop=True)
print(f"[1] Duplicate: xóa {before-len(prd)}")

# BƯỚC 2: STATUS — normalize về lowercase
prd["_status"] = prd["status"].apply(
    lambda x: str(x).lower().strip() if pd.notna(x) else "unknown"
)
changed = prd["status"].fillna("") != prd["_status"]
for idx in prd[changed].index:
    log.append(make_log("products", prd.loc[idx,"product_id"], "status",
                        prd.loc[idx,"status"], prd.loc[idx,"_status"], "STATUS_NORMALIZED"))
prd["status"] = prd["_status"]
prd = prd.drop(columns=["_status"])
print(f"[2] status: {prd['status'].value_counts().to_dict()}")

# BƯỚC 3: PRICE_VND — flag bất thường, không tự sửa
price = pd.to_numeric(prd["price_vnd"], errors="coerce")
for idx in prd[price < 0].index:
    flagged.append(make_flag("products", prd.loc[idx,"product_id"],
                             "PRICE_NEGATIVE", "price_vnd", prd.loc[idx,"price_vnd"],
                             "Giá âm — cần xác nhận giá đúng"))
for idx in prd[price == 0].index:
    flagged.append(make_flag("products", prd.loc[idx,"product_id"],
                             "PRICE_ZERO", "price_vnd", 0, "Giá = 0 — sản phẩm miễn phí hay lỗi?"))
prd["price_vnd"] = price.round(0).astype("Int64")
print(f"[3] price_vnd: âm={( price<0).sum()} | zero={(price==0).sum()} → FLAG")

# BƯỚC 4: STOCK_QTY — âm → 0, flag
stock = pd.to_numeric(prd["stock_qty"], errors="coerce")
neg_stock = stock < 0
for idx in prd[neg_stock].index:
    log.append(make_log("products", prd.loc[idx,"product_id"], "stock_qty",
                        prd.loc[idx,"stock_qty"], 0, "STOCK_NEGATIVE_ZEROED"))
    flagged.append(make_flag("products", prd.loc[idx,"product_id"],
                             "STOCK_NEGATIVE", "stock_qty", prd.loc[idx,"stock_qty"],
                             "Stock âm → set 0"))
prd["stock_qty"] = stock.where(~neg_stock, 0).fillna(0).astype(int)
print(f"[4] stock_qty: set 0 cho {neg_stock.sum()} dòng")

# BƯỚC 5: WEIGHT_KG — parse an toàn
# Python đọc CSV không bị lỗi Date object như GAS
# Chỉ cần xử lý dấu phẩy thập phân
res_w = prd["weight_kg"].apply(parse_weight)
prd["weight_kg"]  = res_w.apply(lambda x: x[0])
weight_action     = res_w.apply(lambda x: x[1])
for idx in prd[weight_action.notna()].index:
    flagged.append(make_flag("products", prd.loc[idx,"product_id"],
                             "WEIGHT_UNPARSEABLE", "weight_kg", df_prd_raw.loc[idx,"weight_kg"],
                             "Không đọc được giá trị cân nặng"))
prd["weight_kg"] = prd["weight_kg"].round(2)
print(f"[5] weight_kg: unparseable={weight_action.notna().sum()}")
print(f"\nProducts: {len(df_prd_raw)} → {len(prd)} dòng")


# ══════════════════════════════════════════════════════════════════════
# PHẦN 6 — LÀM SẠCH ORDERS
# ══════════════════════════════════════════════════════════════════════

# ## Phần 6 — Làm sạch Orders
# Phức tạp nhất — cần dữ liệu sạch từ customers và products để kiểm tra referential integrity.
ord = df_ord_raw.copy()

# Valid IDs từ bảng đã clean — dùng cho referential integrity
valid_cus_ids = set(cus["customer_id"])
valid_prd_ids = set(prd["product_id"])

# BƯỚC 1: DUPLICATE
dup = ord.duplicated(keep="first")
for idx in ord[dup].index:
    log.append(make_log("orders", ord.loc[idx,"order_id"], "order_id",
                        ord.loc[idx,"order_id"], "", "DROPPED_DUPLICATE"))
before = len(ord)
ord = ord.drop_duplicates(keep="first").reset_index(drop=True)
print(f"[1] Duplicate: xóa {before-len(ord)}")

# BƯỚC 2: REFERENTIAL INTEGRITY
orphan_cus = ~ord["customer_id"].isin(valid_cus_ids)
orphan_prd = ~ord["product_id"].isin(valid_prd_ids)
for idx in ord[orphan_cus].index:
    flagged.append(make_flag("orders", ord.loc[idx,"order_id"],
                             "ORPHAN_ORDER", "customer_id", ord.loc[idx,"customer_id"],
                             "customer_id không tồn tại trong customers"))
for idx in ord[orphan_prd].index:
    flagged.append(make_flag("orders", ord.loc[idx,"order_id"],
                             "ORPHAN_ORDER", "product_id", ord.loc[idx,"product_id"],
                             "product_id không tồn tại trong products"))
print(f"[2] Orphan: customer={orphan_cus.sum()} | product={orphan_prd.sum()} → FLAG")

# BƯỚC 3: CURRENCY — Chỉ đổi flag currency → VND
# Không nhân unit_price × USD_RATE vì cột tên "unit_price_vnd" đã là VND rồi
# Ví dụ: unit_price=773,000 VND, total=34.01 USD (nhầm) → chỉ đổi currency
# Bước 6 sẽ phát hiện total sai (34.01 ≠ 773,000×qty) và tính lại tự động
usd = ord["currency"].str.upper() == "USD"
for idx in ord[usd].index:
    log.append(make_log("orders", ord.loc[idx,"order_id"], "currency",
                        "USD", "VND", "CURRENCY_FIXED"))
    log.append(make_log("orders", ord.loc[idx,"order_id"], "total_amount",
                        ord.loc[idx,"total_amount"], "(tính lại từ unit_price × qty)",
                        "TOTAL_WILL_RECALCULATE"))
ord["currency"] = "VND"
print(f"[3] Currency flag USD→VND: {usd.sum()} dòng (total sẽ tính lại ở bước 6)")

# BƯỚC 4: PARSE DATES
res_od = ord["order_date"].apply(parse_vi_date)
res_sd = ord["ship_date"].apply(parse_vi_date)
ord["order_date"] = res_od.apply(lambda x: x[0])
ord["ship_date"]  = res_sd.apply(lambda x: x[0])
print(f"[4] Dates: order null={ord['order_date'].isnull().sum()} | ship null={ord['ship_date'].isnull().sum()}")

# BƯỚC 5: CROSS-COLUMN — ship_date trước order_date
cross = ord["ship_date"].notna() & ord["order_date"].notna() & (ord["ship_date"] < ord["order_date"])
for idx in ord[cross].index:
    flagged.append(make_flag("orders", ord.loc[idx,"order_id"],
                             "SHIP_BEFORE_ORDER", "ship_date × order_date",
                             f"ship={ord.loc[idx,'ship_date']}, order={ord.loc[idx,'order_date']}",
                             "ship_date trước order_date — bất khả thi"))
print(f"[5] Cross ship<order: {cross.sum()} → FLAG")

# Format date về string
ord["order_date"] = ord["order_date"].dt.strftime("%Y-%m-%d")
ord["ship_date"]  = ord["ship_date"].dt.strftime("%Y-%m-%d")

# BƯỚC 6: UNIT_PRICE & TOTAL — parse số an toàn, tính lại total
unit_price = pd.to_numeric(ord["unit_price_vnd"], errors="coerce")
qty        = pd.to_numeric(ord["quantity"],       errors="coerce").fillna(0).astype(int)
total      = pd.to_numeric(ord["total_amount"],   errors="coerce")

# Flag unit_price bất thường
inv_price = unit_price <= 0
for idx in ord[inv_price].index:
    flagged.append(make_flag("orders", ord.loc[idx,"order_id"],
                             "PRICE_INVALID", "unit_price_vnd", ord.loc[idx,"unit_price_vnd"],
                             "Giá ≤ 0 hoặc không đọc được"))
outlier_price = unit_price > 100_000_000
for idx in ord[outlier_price].index:
    flagged.append(make_flag("orders", ord.loc[idx,"order_id"],
                             "PRICE_OUTLIER", "unit_price_vnd", unit_price[idx],
                             "Giá > 100 triệu — outlier, xem xét ở EDA"))

# Tính lại total nếu lệch > 1%
expected = unit_price * qty
wrong_total = (unit_price > 0) & (qty > 0) & (
    total.isnull() | ((total - expected).abs() > expected.abs() * 0.01)
)
for idx in ord[wrong_total].index:
    log.append(make_log("orders", ord.loc[idx,"order_id"], "total_amount",
                        ord.loc[idx,"total_amount"], expected[idx], "TOTAL_RECALCULATED"))
ord.loc[wrong_total, "total_amount"] = expected[wrong_total]
ord["unit_price_vnd"] = pd.to_numeric(unit_price, errors="coerce").fillna(0).round().astype("Int64")
ord["total_amount"]   = pd.to_numeric(ord["total_amount"], errors="coerce").fillna(0).round().astype("Int64")
print(f"[6] Price invalid={inv_price.sum()} outlier={outlier_price.sum()} | Total tính lại={wrong_total.sum()}")

# BƯỚC 7: DISCOUNT_PCT — null → 0
null_disc = ord["discount_pct"].isnull()
for idx in ord[null_disc].index:
    log.append(make_log("orders", ord.loc[idx,"order_id"], "discount_pct", None, 0, "FILLED_NULL"))
ord["discount_pct"] = ord["discount_pct"].fillna(0)

# BƯỚC 8: SHIPPING_ADDRESS — parse JSON, fix broken, fill Không xác định
addr_res = ord["shipping_address"].apply(parse_address)
ord["addr_street"]   = addr_res.apply(lambda x: x[0])
ord["addr_district"] = addr_res.apply(lambda x: x[1])
ord["addr_city"]     = addr_res.apply(lambda x: x[2])
addr_action          = addr_res.apply(lambda x: x[3])
for idx in ord.index:
    if addr_action[idx] == "ADDRESS_FIXED":
        log.append(make_log("orders", ord.loc[idx,"order_id"], "shipping_address",
                            ord.loc[idx,"shipping_address"],
                            ord.loc[idx,"shipping_address"] + "}", "ADDRESS_FIXED"))
    elif addr_action[idx] in ("ADDRESS_MISSING", "ADDRESS_INVALID"):
        flagged.append(make_flag("orders", ord.loc[idx,"order_id"],
                                 addr_action[idx], "shipping_address",
                                 ord.loc[idx,"shipping_address"],
                                 "Địa chỉ không hợp lệ hoặc trống"))
print(f"[8] Address: fixed={( addr_action=='ADDRESS_FIXED').sum()} | "
      f"missing={(addr_action=='ADDRESS_MISSING').sum()} | "
      f"invalid={(addr_action=='ADDRESS_INVALID').sum()}")

# DERIVED: amount_after_discount
ord["amount_after_discount"] = (
    ord["total_amount"] * (1 - ord["discount_pct"] / 100)
).fillna(0).round(-2).astype("Int64")

print(f"\nOrders: {len(df_ord_raw)} → {len(ord)} dòng")


# ══════════════════════════════════════════════════════════════════════
# PHẦN 7 — VALIDATE
# ══════════════════════════════════════════════════════════════════════

# ## Phần 7 — Validate
# CUSTOMERS
assert cus.duplicated().sum() == 0, "❌ customers còn duplicate!"
assert cus["membership_tier"].isin(["Bronze","Silver","Gold","Platinum","Không xác định"]).all()

# PRODUCTS
assert (prd["stock_qty"] >= 0).all(), "❌ stock_qty âm!"
assert prd["status"].isin(["active","inactive","unknown"]).all()

# ORDERS
assert ord.duplicated().sum() == 0, "❌ orders còn duplicate!"
assert (ord["currency"] == "VND").all(), "❌ Còn currency không phải VND!"
assert ord["discount_pct"].isnull().sum() == 0, "❌ discount_pct còn null!"

print("✅ Tất cả assert passed!")
print(f"\ncustomers: {len(df_cus_raw)} → {len(cus)} | {len(cus.columns)} cols")
print(f"products:  {len(df_prd_raw)} → {len(prd)} | {len(prd.columns)} cols")
print(f"orders:    {len(df_ord_raw)} → {len(ord)} | {len(ord.columns)} cols")

df_flag = pd.DataFrame(flagged)
if not df_flag.empty:
    print(f"\n⚠️  Flagged ({len(flagged)} items):")
    print(df_flag["flag_type"].value_counts().to_string())


# ══════════════════════════════════════════════════════════════════════
# PHẦN 8 — EXPORT
# ══════════════════════════════════════════════════════════════════════

# ## Phần 8 — Export
import os
os.makedirs("data/clean/project-03-ecommerce", exist_ok=True)

cus.to_csv("data/clean/project-03-ecommerce/customers_clean.csv", index=False, encoding="utf-8")
prd.to_csv("data/clean/project-03-ecommerce/products_clean.csv",  index=False, encoding="utf-8")
ord.to_csv("data/clean/project-03-ecommerce/orders_clean.csv",     index=False, encoding="utf-8")

if log:
    pd.DataFrame(log).to_csv("data/clean/project-03-ecommerce/ecommerce_cleaning_log.csv", index=False)
if flagged:
    pd.DataFrame(flagged).to_csv("data/clean/project-03-ecommerce/ecommerce_flagged.csv", index=False)

print("✅ Đã lưu 5 file vào data/clean/")
print(f"  customers_clean.csv : {len(cus)} rows")
print(f"  products_clean.csv  : {len(prd)} rows")
print(f"  orders_clean.csv    : {len(ord)} rows")
print(f"  cleaning_log.csv    : {len(log)} entries")
print(f"  flagged.csv         : {len(flagged)} items")
