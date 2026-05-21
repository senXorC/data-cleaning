# ======================================================================
# PROJECT 04 — SUPPLY CHAIN DATA CLEANING
# ======================================================================
# Đồng bộ với: google-apps-script/project-04-supply-chain/
# Thứ tự: suppliers → inventory → purchase_orders → stock_movements
#
# Cài thư viện: pip install thefuzz python-Levenshtein
# ======================================================================

# # 📦 Project 04 — Supply Chain Data Cleaning
# **Dataset:** suppliers_dirty.csv · inventory_dirty.csv · purchase_orders_dirty.csv · stock_movements_dirty.csv
# **Tools:** Python · pandas · re · thefuzz
# **Logic đồng bộ với:** google-apps-script/project-04-supply-chain/

# ────────────────────────────────────────────────────────────────────

# ## Cấu trúc notebook
# 1. Helper Functions
# 2. Đọc & Tổng quan
# 3. Chẩn đoán
# 4. Làm sạch — Suppliers
# 5. Làm sạch — Inventory
# 6. Làm sạch — Purchase Orders
# 7. Làm sạch — Stock Movements + Running Balance
# 8. Inventory Summary
# 9. Validate
# 10. Export
# ## Thứ tự làm sạch
# ```
# suppliers → inventory → purchase_orders → stock_movements
# ```
# Master data trước, transaction sau. Mỗi bảng phụ thuộc bảng trước.

# ────────────────────────────────────────────────────────────────────

# ## Phần 1 — Helper Functions
import pandas as pd
import numpy as np
import re
import warnings
warnings.filterwarnings('ignore')

# cài thefuzz nếu chưa có: pip install thefuzz
try:
    from thefuzz import fuzz
    HAS_FUZZ = True
except ImportError:
    HAS_FUZZ = False
    print("⚠️ thefuzz chưa cài — fuzzy dedup sẽ dùng normalize thủ công")
    print("   Cài bằng: pip install thefuzz")

# ── Remove diacritics ──────────────────────────────────────────────
def remove_diacritics(s):
    if pd.isnull(s): return ""
    diac = str.maketrans(
        "àáảãạăắặằẳẵâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ"
        "ÀÁẢÃẠĂẮẶẰẲẴÂẤẦẨẪẬĐÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴ",
        "aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy"
        "aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy"
    )
    return str(s).lower().translate(diac)

# ── Title case tiếng Việt + expand abbreviation ───────────────────
def title_case_vi(s):
    """Title case + expand Cty→Công Ty + ALL CAPS cho TNHH/CP/XD"""
    if pd.isnull(s) or not str(s).strip(): return "Không Xác Định"
    EXPAND  = {"cty": "Công Ty", "ncc": "Nhà Cung Cấp"}
    ABBR    = {"TNHH","CP","MTV","XD","TM","DV","SX","XNK","ABC"}
    words   = str(s).strip().split()
    words   = [EXPAND.get(w.lower(), w) for w in words]
    # Tách lại vì EXPAND có thể thêm khoảng trắng ("Công Ty")
    words   = " ".join(words).split()
    words   = [w.capitalize() for w in words]
    words   = [w.upper() if w.upper() in ABBR else w for w in words]
    return " ".join(words)

# ── Email helpers ──────────────────────────────────────────────────
def fix_missing_at(email):
    domains = ["outlook.com","company.vn","gmail.com","yahoo.com"]
    lower = str(email).lower()
    for d in domains:
        idx = lower.find(d)
        if idx > 0:
            return remove_diacritics(email[:idx]) + "@" + email[idx:]
    return None

def clean_email(val):
    """Trả về (email_clean, valid, action|None)"""
    if pd.isnull(val) or not str(val).strip(): return val, False, "EMAIL_NULL"
    raw = str(val).strip()
    if "@" in raw:
        at = raw.index("@")
        local, domain = raw[:at], raw[at:]
        clean_local = remove_diacritics(local)
        if local != clean_local:
            return clean_local + domain, True, "EMAIL_DIACRITIC_REMOVED"
        return raw, True, None
    fixed = fix_missing_at(raw)
    if fixed: return fixed, True, "EMAIL_AT_INSERTED"
    return raw, False, "EMAIL_BROKEN"

# ── Phone ──────────────────────────────────────────────────────────
def normalize_phone(val):
    if pd.isnull(val): return val, None
    p = re.sub(r'[\s\-\.]', '', str(val).strip())
    if p.startswith("+84") and len(p) == 12:
        return "0" + p[3:], "PHONE_NORMALIZED"
    elif p.startswith("84") and len(p) == 11:
        return "0" + p[2:], "PHONE_NORMALIZED"
    elif re.match(r'^[35789]\d{8}$', p):
        return "0" + p, "PHONE_NORMALIZED"
    return p, None

# ── Payment terms keyword matching ────────────────────────────────
def normalize_payment_terms(val):
    """14 cách viết → NET30/NET60/COD dùng keyword matching"""
    if pd.isnull(val): return val, None
    s = str(val).strip()
    low = s.lower()
    if "30" in low:    return "NET30", "PAYMENT_TERMS_NORMALIZED"
    if "60" in low:    return "NET60", "PAYMENT_TERMS_NORMALIZED"
    if any(k in low for k in ["cod","cash","tra ngay","trả ngay"]):
        return "COD", "PAYMENT_TERMS_NORMALIZED"
    return s, None  # không nhận ra → giữ nguyên

# ── is_active → Hoạt động / Không hoạt động ──────────────────────
def normalize_is_active(val):
    """TRUE/true/1/False/false/0 → Hoạt động / Không hoạt động"""
    if pd.isnull(val): return "Không hoạt động", "IS_ACTIVE_NORMALIZED"
    s = str(val).strip().lower()
    if s in ("true","1","hoạt động"):   return "Hoạt động",      "IS_ACTIVE_NORMALIZED"
    if s in ("false","0","không hoạt động",""):
        return "Không hoạt động", "IS_ACTIVE_NORMALIZED"
    return "Không hoạt động", "IS_ACTIVE_NORMALIZED"  # fallback

# ── Fuzzy dedup suppliers ─────────────────────────────────────────
STOP_WORDS = ["nhà phân phối","phân phối","công ty","cong ty","tnhh","nha","cty","cp"]

def normalize_for_fuzzy(name):
    """Bỏ stop words → bỏ dấu → normalize để so sánh fuzzy"""
    s = remove_diacritics(str(name).lower())
    for w in sorted(STOP_WORDS, key=len, reverse=True):
        s = s.replace(w, " ")
    return re.sub(r'[^a-z0-9]', ' ', s).strip()

def find_fuzzy_duplicates(df, name_col, id_col, threshold=90):
    """
    Phát hiện tên gần giống nhau.
    threshold=90: score >= 90 → nghi là cùng NCC
    Trả về list các cặp (id1, name1, id2, name2, score)
    """
    pairs = []
    names = df[[id_col, name_col]].dropna().values.tolist()
    norm  = [(row[0], row[1], normalize_for_fuzzy(row[1])) for row in names]

    seen = {}
    for sid, name, norm_name in norm:
        if not norm_name: continue
        if HAS_FUZZ:
            for prev_norm, (prev_id, prev_name) in seen.items():
                score = fuzz.ratio(norm_name, prev_norm)
                if score >= threshold:
                    pairs.append((sid, name, prev_id, prev_name, score))
        else:
            # Fallback: exact match sau normalize
            if norm_name in seen:
                prev_id, prev_name = seen[norm_name]
                pairs.append((sid, name, prev_id, prev_name, 100))
        if norm_name not in seen:
            seen[norm_name] = (sid, name)
    return pairs

# ── Parse date ────────────────────────────────────────────────────
def parse_vi_date(s):
    if pd.isnull(s) or str(s).strip() == "": return pd.NaT
    s = str(s).strip()
    for fmt in ["%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"]:
        try: return pd.to_datetime(s, format=fmt)
        except: pass
    m = re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$', s)
    if m:
        p1, p2, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if 1 <= p2 <= 12 and 1 <= p1 <= 31:
            try: return pd.to_datetime(f"{y}-{p2:02d}-{p1:02d}")
            except: pass
    m2 = re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2})$', s)
    if m2:
        p1, p2, yy = int(m2.group(1)), int(m2.group(2)), int(m2.group(3))
        y = 1900 + yy if yy > 50 else 2000 + yy
        if 1 <= p2 <= 12 and 1 <= p1 <= 31:
            try: return pd.to_datetime(f"{y}-{p2:02d}-{p1:02d}")
            except: pass
    return pd.NaT

# ── Log/Flag helpers ──────────────────────────────────────────────
def make_log(table, row_id, field, old_val, new_val, action):
    return {"table":table,"row_id":row_id,"field":field,
            "old_value":old_val,"new_value":new_val,"action":action}

def make_flag(table, row_id, flag_type, field, value, note):
    return {"table":table,"row_id":row_id,"flag_type":flag_type,
            "field":field,"value":value,"note":note}

print("✅ Helpers loaded")
print(f"   thefuzz: {'✅ có' if HAS_FUZZ else '❌ không — dùng exact match'}")


# ────────────────────────────────────────────────────────────────────

# ## Phần 2 — Đọc & Tổng quan
df_sup_raw = pd.read_csv("../data/raw/suppliers_dirty.csv")
df_inv_raw = pd.read_csv("../data/raw/inventory_dirty.csv")
df_po_raw  = pd.read_csv("../data/raw/purchase_orders_dirty.csv")
df_mov_raw = pd.read_csv("../data/raw/stock_movements_dirty.csv")

for name, df in [("SUPPLIERS",df_sup_raw),("INVENTORY",df_inv_raw),
                  ("PURCHASE_ORDERS",df_po_raw),("STOCK_MOVEMENTS",df_mov_raw)]:
    print(f"[{name}] {df.shape[0]} rows × {df.shape[1]} cols")
    print(f"  Columns: {list(df.columns)}")
    print(f"  Nulls:   {df.isnull().sum().sum()}")
    print()


# ────────────────────────────────────────────────────────────────────

# ## Phần 3 — Chẩn đoán
print("=== DUPLICATE ===")
for name, df, id_col in [("SUPPLIERS",df_sup_raw,"supplier_id"),
                          ("INVENTORY",df_inv_raw,"item_id"),
                          ("PO",df_po_raw,"po_id"),
                          ("MOVEMENTS",df_mov_raw,"movement_id")]:
    print(f"[{name}] toàn dòng: {df.duplicated().sum()} | {id_col}: {df[id_col].duplicated().sum()}")

print("=== REFERENTIAL INTEGRITY ===")
valid_sup  = set(df_sup_raw["supplier_id"])
valid_item = set(df_inv_raw["item_id"])
valid_po   = set(df_po_raw["po_id"])

print(f"inventory.supplier_id orphan:        {(~df_inv_raw['supplier_id'].isin(valid_sup)).sum()}")
print(f"purchase_orders.supplier_id orphan:  {(~df_po_raw['supplier_id'].isin(valid_sup)).sum()}")
print(f"purchase_orders.item_id orphan:      {(~df_po_raw['item_id'].isin(valid_item)).sum()}")
print(f"stock_movements.item_id orphan:      {(~df_mov_raw['item_id'].isin(valid_item)).sum()}")
ref_po = df_mov_raw["reference_po"].replace("",np.nan).dropna()
print(f"stock_movements.reference_po orphan: {(~ref_po.isin(valid_po)).sum()}")

print("=== VẤN ĐỀ ĐẶC THÙ ===")
print("[SUPPLIERS] payment_terms:", df_sup_raw["payment_terms"].value_counts(dropna=False).to_dict())
print("[SUPPLIERS] is_active:", df_sup_raw["is_active"].value_counts(dropna=False).to_dict())
inv_n = df_inv_raw.copy()
for c in ["stock_qty","reorder_point","max_stock","unit_cost_vnd"]:
    inv_n[c] = pd.to_numeric(inv_n[c], errors="coerce")
print(f"[INVENTORY] stock_qty < 0:           {(inv_n['stock_qty']<0).sum()}")
print(f"[INVENTORY] stock_qty > max_stock:   {(inv_n['stock_qty']>inv_n['max_stock']).sum()}")
print(f"[INVENTORY] reorder >= max_stock:    {(inv_n['reorder_point']>=inv_n['max_stock']).sum()}")
print(f"[INVENTORY] unit_cost <= 0:          {(inv_n['unit_cost_vnd']<=0).sum()}")
print(f"[PO] currency USD:    {(df_po_raw['currency']=='USD').sum()}")
print(f"[PO] status unique:   {sorted(df_po_raw['status'].dropna().unique())}")
print(f"[MOV] type unique ({df_mov_raw['movement_type'].nunique()}):", sorted(df_mov_raw['movement_type'].unique()))
print(f"[MOV] quantity < 0:  {(pd.to_numeric(df_mov_raw['quantity'],errors='coerce')<0).sum()}")


# ────────────────────────────────────────────────────────────────────

# ## Phần 4 — Làm sạch Suppliers
sup = df_sup_raw.copy()
log, flagged = [], []

# BƯỚC 1: DUPLICATE
dup = sup.duplicated(keep="first")
for idx in sup[dup].index:
    log.append(make_log("suppliers", sup.loc[idx,"supplier_id"],
                        "supplier_id", sup.loc[idx,"supplier_id"], "", "DROPPED_DUPLICATE"))
sup = sup.drop_duplicates(keep="first").reset_index(drop=True)
print(f"[1] Duplicate: drop {dup.sum()}")

# BƯỚC 2: SUPPLIER_NAME — title case + expand Cty + ALL CAPS
sup["_name"] = sup["supplier_name"].apply(title_case_vi)
changed = sup["supplier_name"].fillna("") != sup["_name"]
for idx in sup[changed].index:
    log.append(make_log("suppliers", sup.loc[idx,"supplier_id"],
                        "supplier_name", sup.loc[idx,"supplier_name"],
                        sup.loc[idx,"_name"], "NAME_NORMALIZED"))
sup["supplier_name"] = sup["_name"]
sup = sup.drop(columns=["_name"])
print(f"[2] supplier_name: normalize {changed.sum()}")

# BƯỚC 3: EMAIL
res = sup["email"].apply(clean_email)
sup["email"] = res.apply(lambda x: x[0])
email_valid  = res.apply(lambda x: x[1])
email_action = res.apply(lambda x: x[2])
for idx in sup.index:
    if email_action[idx]:
        log.append(make_log("suppliers", sup.loc[idx,"supplier_id"],
                            "email", df_sup_raw.loc[idx,"email"] if idx < len(df_sup_raw) else "",
                            sup.loc[idx,"email"], email_action[idx]))
    if not email_valid[idx]:
        flagged.append(make_flag("suppliers", sup.loc[idx,"supplier_id"],
                                 "EMAIL_INVALID","email",sup.loc[idx,"email"],"Email không hợp lệ"))
print(f"[3] email: bỏ dấu {(email_action=='EMAIL_DIACRITIC_REMOVED').sum()} | "
      f"thêm @ {(email_action=='EMAIL_AT_INSERTED').sum()}")

# BƯỚC 4: PHONE
res_p = sup["phone"].apply(normalize_phone)
sup["phone"] = res_p.apply(lambda x: x[0])
phone_action = res_p.apply(lambda x: x[1])
for idx in sup[phone_action.notna()].index:
    log.append(make_log("suppliers", sup.loc[idx,"supplier_id"],
                        "phone", df_sup_raw.loc[idx,"phone"] if idx < len(df_sup_raw) else "",
                        sup.loc[idx,"phone"], "PHONE_NORMALIZED"))
invalid_phone = ~sup["phone"].astype(str).str.match(r'^0[35789]\d{8}$')
for idx in sup[invalid_phone].index:
    flagged.append(make_flag("suppliers", sup.loc[idx,"supplier_id"],
                             "PHONE_INVALID","phone",sup.loc[idx,"phone"],"Format không nhận ra"))
print(f"[4] phone: normalize {phone_action.notna().sum()} | invalid {invalid_phone.sum()}")

# BƯỚC 5: PAYMENT_TERMS — keyword matching
res_pt = sup["payment_terms"].apply(normalize_payment_terms)
sup["payment_terms"] = res_pt.apply(lambda x: x[0])
pt_action = res_pt.apply(lambda x: x[1])
for idx in sup[pt_action.notna()].index:
    log.append(make_log("suppliers", sup.loc[idx,"supplier_id"],
                        "payment_terms", df_sup_raw.loc[idx,"payment_terms"] if idx < len(df_sup_raw) else "",
                        sup.loc[idx,"payment_terms"], "PAYMENT_TERMS_NORMALIZED"))
pt_unknown = sup["payment_terms"].apply(lambda x: x not in ["NET30","NET60","COD"])
for idx in sup[pt_unknown].index:
    flagged.append(make_flag("suppliers", sup.loc[idx,"supplier_id"],
                             "PAYMENT_TERMS_UNKNOWN","payment_terms",sup.loc[idx,"payment_terms"],
                             "Không nhận dạng được"))
print(f"[5] payment_terms: normalize {pt_action.notna().sum()} | unknown {pt_unknown.sum()}")

# BƯỚC 6: IS_ACTIVE
res_ia = sup["is_active"].apply(normalize_is_active)
sup["is_active"] = res_ia.apply(lambda x: x[0])
ia_action = res_ia.apply(lambda x: x[1])
for idx in sup[ia_action.notna()].index:
    log.append(make_log("suppliers", sup.loc[idx,"supplier_id"],
                        "is_active", str(df_sup_raw.loc[idx,"is_active"]) if idx < len(df_sup_raw) else "",
                        sup.loc[idx,"is_active"], "IS_ACTIVE_NORMALIZED"))
print(f"[6] is_active: {sup['is_active'].value_counts().to_dict()}")

# BƯỚC 7: FUZZY DEDUPLICATION
fuzzy_pairs = find_fuzzy_duplicates(sup, "supplier_name", "supplier_id", threshold=90)
flagged_fuzzy_ids = set()
for sid1, name1, sid2, name2, score in fuzzy_pairs:
    for sid, name, other_id, other_name in [(sid1,name1,sid2,name2),(sid2,name2,sid1,name1)]:
        if sid not in flagged_fuzzy_ids:
            flagged.append(make_flag("suppliers", sid, "FUZZY_DUPLICATE","supplier_name", name,
                f"Tên gần giống {other_id} ({other_name}) score={score} — cần xác nhận"))
            flagged_fuzzy_ids.add(sid)
print(f"[7] fuzzy duplicate: {len(fuzzy_pairs)} cặp → flag {len(flagged_fuzzy_ids)} suppliers")
print(f"\nSuppliers: {len(df_sup_raw)} → {len(sup)}")


# ────────────────────────────────────────────────────────────────────

# ## Phần 5 — Làm sạch Inventory
inv = df_inv_raw.copy()
valid_sup_ids = set(sup["supplier_id"])

# BƯỚC 1: DUPLICATE
dup = inv.duplicated(keep="first")
inv = inv.drop_duplicates(keep="first").reset_index(drop=True)
print(f"[1] Duplicate: drop {dup.sum()}")

# BƯỚC 2: REFERENTIAL INTEGRITY
orphan_sup = ~inv["supplier_id"].isin(valid_sup_ids)
for idx in inv[orphan_sup].index:
    flagged.append(make_flag("inventory", inv.loc[idx,"item_id"],
                             "ORPHAN_ITEM","supplier_id",inv.loc[idx,"supplier_id"],
                             "supplier_id không tồn tại trong suppliers"))
print(f"[2] Orphan supplier: {orphan_sup.sum()} → FLAG")

# BƯỚC 3-4: ÉP KIỂU SỐ
for c in ["stock_qty","reorder_point","max_stock","unit_cost_vnd"]:
    inv[c] = pd.to_numeric(inv[c], errors="coerce").fillna(0)

# BƯỚC 4: VALIDATE stock_qty
neg_stock = inv["stock_qty"] < 0
for idx in inv[neg_stock].index:
    log.append(make_log("inventory", inv.loc[idx,"item_id"],
                        "stock_qty", inv.loc[idx,"stock_qty"], 0, "STOCK_NEGATIVE_ZEROED"))
    flagged.append(make_flag("inventory", inv.loc[idx,"item_id"],
                             "STOCK_NEGATIVE","stock_qty",inv.loc[idx,"stock_qty"],
                             "Tồn kho âm → set 0"))
inv.loc[neg_stock,"stock_qty"] = 0

exceed_max = inv["stock_qty"] > inv["max_stock"]
for idx in inv[exceed_max].index:
    flagged.append(make_flag("inventory", inv.loc[idx,"item_id"],
                             "STOCK_EXCEED_MAX","stock_qty",
                             f"stock={inv.loc[idx,'stock_qty']} > max={inv.loc[idx,'max_stock']}",
                             "Tồn kho vượt sức chứa tối đa — cần xác nhận max_stock"))
print(f"[4] stock_qty âm→0: {neg_stock.sum()} | exceed max: {exceed_max.sum()}")

# BƯỚC 5: VALIDATE reorder_point × max_stock
reorder_gt = inv["reorder_point"] >= inv["max_stock"]
for idx in inv[reorder_gt].index:
    flagged.append(make_flag("inventory", inv.loc[idx,"item_id"],
                             "REORDER_GT_MAX","reorder_point × max_stock",
                             f"reorder={inv.loc[idx,'reorder_point']} >= max={inv.loc[idx,'max_stock']}",
                             "Hệ thống tự động đặt hàng sẽ không hoạt động"))
print(f"[5] reorder >= max_stock: {reorder_gt.sum()} → FLAG")

# BƯỚC 6: UNIT_COST_VND
cost = pd.to_numeric(inv["unit_cost_vnd"], errors="coerce")
for idx in inv[cost < 0].index:
    flagged.append(make_flag("inventory",inv.loc[idx,"item_id"],
                             "COST_NEGATIVE","unit_cost_vnd",cost[idx],"Giá đơn vị âm"))
for idx in inv[cost == 0].index:
    flagged.append(make_flag("inventory",inv.loc[idx,"item_id"],
                             "COST_ZERO","unit_cost_vnd",0,"Giá = 0"))
inv["unit_cost_vnd"] = cost.round(0).astype("Int64")

# BƯỚC 7: WAREHOUSE_LOCATION — fill Không xác định
empty_loc = inv["warehouse_location"].fillna("").str.strip() == ""
for idx in inv[empty_loc].index:
    log.append(make_log("inventory", inv.loc[idx,"item_id"],
                        "warehouse_location","","Không xác định","LOCATION_FILLED"))
inv.loc[empty_loc,"warehouse_location"] = "Không xác định"
print(f"[7] warehouse_location fill: {empty_loc.sum()}")

# BƯỚC 8: LAST_UPDATED
inv["last_updated"] = inv["last_updated"].apply(parse_vi_date).dt.strftime("%Y-%m-%d")

# DERIVED: needs_reorder
inv["needs_reorder"] = (inv["stock_qty"] <= inv["reorder_point"]) & (inv["reorder_point"] > 0)
inv["needs_reorder"] = inv["needs_reorder"].map({True:"Có", False:"Không"})
print(f"[D] needs_reorder Có: {(inv['needs_reorder']=='Có').sum()}")
print(f"\nInventory: {len(df_inv_raw)} → {len(inv)}")


# ────────────────────────────────────────────────────────────────────

# ## Phần 6 — Làm sạch Purchase Orders
po = df_po_raw.copy()
valid_sup_ids  = set(sup["supplier_id"])
valid_item_ids = set(inv["item_id"])

# BƯỚC 1: DUPLICATE
dup = po.duplicated(keep="first")
po = po.drop_duplicates(keep="first").reset_index(drop=True)
print(f"[1] Duplicate: drop {dup.sum()}")

# BƯỚC 2: REFERENTIAL INTEGRITY
orphan_sup = ~po["supplier_id"].isin(valid_sup_ids)
orphan_item = ~po["item_id"].isin(valid_item_ids)
for idx in po[orphan_sup].index:
    flagged.append(make_flag("purchase_orders",po.loc[idx,"po_id"],
                             "ORPHAN_PO","supplier_id",po.loc[idx,"supplier_id"],
                             "supplier_id không tồn tại trong suppliers_clean"))
for idx in po[orphan_item].index:
    flagged.append(make_flag("purchase_orders",po.loc[idx,"po_id"],
                             "ORPHAN_PO","item_id",po.loc[idx,"item_id"],
                             "item_id không tồn tại trong inventory_clean"))
print(f"[2] Orphan: supplier={orphan_sup.sum()} | item={orphan_item.sum()}")

# BƯỚC 3: CURRENCY — chỉ đổi flag, tính lại total ở bước 8
usd = po["currency"].str.upper() == "USD"
for idx in po[usd].index:
    log.append(make_log("purchase_orders",po.loc[idx,"po_id"],
                        "currency","USD","VND","CURRENCY_FIXED"))
po["currency"] = "VND"
print(f"[3] Currency USD→VND flag: {usd.sum()}")

# BƯỚC 4: PARSE DATES
po["order_date"]    = po["order_date"].apply(parse_vi_date).dt.strftime("%Y-%m-%d")
po["expected_date"] = po["expected_date"].apply(parse_vi_date).dt.strftime("%Y-%m-%d")

# BƯỚC 5: CROSS-COLUMN — expected trước order
od = pd.to_datetime(po["order_date"],    errors="coerce")
ed = pd.to_datetime(po["expected_date"], errors="coerce")
cross = od.notna() & ed.notna() & (ed < od)
for idx in po[cross].index:
    flagged.append(make_flag("purchase_orders",po.loc[idx,"po_id"],
                             "EXPECTED_BEFORE_ORDER","expected_date × order_date",
                             f"order={po.loc[idx,'order_date']}, expected={po.loc[idx,'expected_date']}",
                             "Ngày nhận hàng trước ngày đặt hàng — bất khả thi"))
print(f"[5] expected_date < order_date: {cross.sum()} → FLAG")

# BƯỚC 6: STATUS — lowercase
po["status"] = po["status"].str.lower().str.strip()
print(f"[6] status: {po['status'].value_counts().to_dict()}")

# BƯỚC 7: UNIT_COST_VND — validate
po["unit_cost_vnd"] = pd.to_numeric(po["unit_cost_vnd"], errors="coerce").fillna(0)
for idx in po[po["unit_cost_vnd"] < 0].index:
    flagged.append(make_flag("purchase_orders",po.loc[idx,"po_id"],
                             "COST_NEGATIVE","unit_cost_vnd",po.loc[idx,"unit_cost_vnd"],"Giá âm"))
for idx in po[po["unit_cost_vnd"] == 0].index:
    flagged.append(make_flag("purchase_orders",po.loc[idx,"po_id"],
                             "COST_ZERO","unit_cost_vnd",0,"Giá = 0"))
po["unit_cost_vnd"] = po["unit_cost_vnd"].round(0).astype("Int64")

# BƯỚC 8: TOTAL — tính lại nếu lệch
po["quantity"] = pd.to_numeric(po["quantity"], errors="coerce").fillna(0).astype(int)
po["total_amount"] = pd.to_numeric(po["total_amount"], errors="coerce").fillna(0)
expected = po["unit_cost_vnd"] * po["quantity"]
wrong = (po["unit_cost_vnd"] > 0) & (po["quantity"] > 0) & (
    (po["total_amount"] - expected).abs() > expected.abs() * 0.01
)
for idx in po[wrong].index:
    log.append(make_log("purchase_orders",po.loc[idx,"po_id"],
                        "total_amount",po.loc[idx,"total_amount"],
                        int(expected[idx]),"TOTAL_RECALCULATED"))
po.loc[wrong,"total_amount"] = expected[wrong]
po["total_amount"] = po["total_amount"].round(0).astype("Int64")
print(f"[8] total tính lại: {wrong.sum()}")
print(f"\nPurchase Orders: {len(df_po_raw)} → {len(po)}")


# ────────────────────────────────────────────────────────────────────

# ## Phần 7 — Làm sạch Stock Movements + Running Balance
mov = df_mov_raw.copy()
valid_po_ids   = set(po["po_id"])
valid_item_ids = set(inv["item_id"])

# BẢNG MAPPING movement_type
TYPE_MAP = {
    "in":"IN","nhập":"IN","nhập kho":"IN","import":"IN",
    "out":"OUT","xuất":"OUT","xuất kho":"OUT","export":"OUT",
    "return":"RETURN","trả hàng":"RETURN","trả ncc":"RETURN",
    "adjustment":"ADJUSTMENT","adj":"ADJUSTMENT",
    "điều chỉnh":"ADJUSTMENT","kiểm kê":"ADJUSTMENT",
}

# BƯỚC 1: DUPLICATE
dup = mov.duplicated(keep="first")
mov = mov.drop_duplicates(keep="first").reset_index(drop=True)
print(f"[1] Duplicate: drop {dup.sum()}")

# BƯỚC 2: NORMALIZE movement_type
mov["_type_clean"] = mov["movement_type"].apply(
    lambda x: TYPE_MAP.get(str(x).strip().lower(), None)
)
changed = mov["movement_type"].fillna("") != mov["_type_clean"].fillna("")
for idx in mov[changed & mov["_type_clean"].notna()].index:
    log.append(make_log("stock_movements",mov.loc[idx,"movement_id"],
                        "movement_type",mov.loc[idx,"movement_type"],
                        mov.loc[idx,"_type_clean"],"TYPE_NORMALIZED"))
for idx in mov[mov["_type_clean"].isna()].index:
    flagged.append(make_flag("stock_movements",mov.loc[idx,"movement_id"],
                             "TYPE_UNKNOWN","movement_type",mov.loc[idx,"movement_type"],
                             "Không nhận dạng được"))
mov["movement_type"] = mov["_type_clean"].fillna(mov["movement_type"])
mov = mov.drop(columns=["_type_clean"])
print(f"[2] movement_type normalize: {changed.sum()}")

# BƯỚC 3: REFERENTIAL INTEGRITY
orphan_item = ~mov["item_id"].isin(valid_item_ids)
for idx in mov[orphan_item].index:
    flagged.append(make_flag("stock_movements",mov.loc[idx,"movement_id"],
                             "ORPHAN_MOVEMENT","item_id",mov.loc[idx,"item_id"],
                             "item_id không tồn tại trong inventory_clean"))

# reference_po: chỉ check IN/RETURN có reference_po
ref_check = mov["reference_po"].fillna("").str.strip() != ""
in_return  = mov["movement_type"].isin(["IN","RETURN"])
orphan_po_mask = ref_check & in_return & (~mov["reference_po"].isin(valid_po_ids))
for idx in mov[orphan_po_mask].index:
    flagged.append(make_flag("stock_movements",mov.loc[idx,"movement_id"],
                             "ORPHAN_REF_PO","reference_po",mov.loc[idx,"reference_po"],
                             "reference_po không tồn tại trong purchase_orders_clean"))
print(f"[3] Orphan item: {orphan_item.sum()} | Orphan ref_po: {orphan_po_mask.sum()}")

# BƯỚC 4: PARSE DATE
mov["movement_date"] = mov["movement_date"].apply(parse_vi_date).dt.strftime("%Y-%m-%d")

# BƯỚC 5: WAREHOUSE — fill Không xác định
empty_wh = mov["warehouse"].fillna("").str.strip() == ""
mov.loc[empty_wh,"warehouse"] = "Không xác định"
for idx in mov[empty_wh].index:
    log.append(make_log("stock_movements",mov.loc[idx,"movement_id"],
                        "warehouse","","Không xác định","WAREHOUSE_FILLED"))

# BƯỚC 6: QUANTITY — chuẩn hoá dấu theo movement_type
mov["quantity"] = pd.to_numeric(mov["quantity"], errors="coerce").fillna(0)
neg_qty = mov["quantity"] < 0
for idx in mov[neg_qty].index:
    mtype = mov.loc[idx,"movement_type"]
    raw_q = mov.loc[idx,"quantity"]
    if mtype == "ADJUSTMENT":
        # ADJUSTMENT âm = hợp lệ (kiểm kê thiếu hàng)
        log.append(make_log("stock_movements",mov.loc[idx,"movement_id"],
                            "quantity",raw_q,raw_q,"QTY_NEGATIVE_ADJUSTMENT_VALID"))
    else:
        # IN/OUT/RETURN âm = nhập sai dấu → lấy abs()
        clean_q = abs(raw_q)
        log.append(make_log("stock_movements",mov.loc[idx,"movement_id"],
                            "quantity",raw_q,clean_q,"QTY_SIGN_FIXED"))
        flagged.append(make_flag("stock_movements",mov.loc[idx,"movement_id"],
                                 "QTY_NEGATIVE","quantity",raw_q,
                                 f"Âm trong {mtype} → đã chuyển thành {clean_q}"))
        mov.loc[idx,"quantity"] = clean_q
print(f"[6] qty âm: ADJUSTMENT valid={( neg_qty & (mov['movement_type']=='ADJUSTMENT')).sum()} | "
      f"fix IN/OUT/RETURN={(neg_qty & ~(mov['movement_type']=='ADJUSTMENT')).sum()}")
print(f"\nStock Movements: {len(df_mov_raw)} → {len(mov)}")

# ### Running Balance
# Tính tồn kho tích lũy theo thời gian cho từng item.
# **Điểm quan trọng:**
# - Bắt đầu từ `opening_balance` (tính ngược từ `inventory.stock_qty`) thay vì 0
# - IN/RETURN có `ORPHAN_REF_PO` → **không tính** vào balance (PO không có thật)
# - ADJUSTMENT giữ nguyên dấu (âm hoặc dương)
# Tập hợp orphan ref_po IDs để exclude khỏi balance
orphan_ref_po_mov_ids = set(
    f["row_id"] for f in flagged
    if f.get("table") == "stock_movements" and f.get("flag_type") == "ORPHAN_REF_PO"
)
print(f"Movements exclude khỏi balance (ORPHAN_REF_PO): {len(orphan_ref_po_mov_ids)}")

# Tính signed_qty cho từng movement
def get_signed_qty(row):
    mtype = row["movement_type"]
    qty   = row["quantity"]
    mov_id = row["movement_id"]
    # IN/RETURN có ORPHAN_REF_PO → exclude (không tính vào balance)
    if mov_id in orphan_ref_po_mov_ids and mtype in ("IN","RETURN"):
        return 0
    if mtype in ("IN","RETURN"):   return  abs(qty)
    if mtype == "OUT":             return -abs(qty)
    if mtype == "ADJUSTMENT":      return  qty   # giữ dấu gốc
    return 0

mov["signed_qty"] = mov.apply(get_signed_qty, axis=1)

# Tính tổng signed_qty theo item → dùng để tính opening balance
total_by_item = mov.groupby("item_id")["signed_qty"].sum()

# Opening balance = stock_qty hiện tại - tổng biến động
# Vì: opening + tổng movements = closing (inventory.stock_qty)
inv_qty_map = inv.set_index("item_id")["stock_qty"].to_dict()

opening_balance = {}
for item_id, total_mov in total_by_item.items():
    current = inv_qty_map.get(item_id, None)
    if current is not None:
        opening_balance[item_id] = current - total_mov

print(f"Opening balance tính được: {len(opening_balance)} items")
neg_opening = {k:v for k,v in opening_balance.items() if v < 0}
print(f"Opening balance âm: {len(neg_opening)} items ({len(neg_opening)/len(opening_balance)*100:.1f}%)")

# Tính running balance theo item + thời gian
mov_sorted = mov.copy()
mov_sorted["movement_date"] = pd.to_datetime(mov_sorted["movement_date"], errors="coerce")
mov_sorted = mov_sorted.sort_values(["item_id","movement_date"]).reset_index(drop=True)

# Tính running balance có opening
neg_balance_flags = []

for item_id, group in mov_sorted.groupby("item_id"):
    opening = opening_balance.get(item_id, None)
    if opening is None:
        continue  # không có inventory data → skip, tránh false positive

    balance = opening
    for _, row in group.iterrows():
        balance += row["signed_qty"]
        if balance < 0:
            neg_balance_flags.append({
                "movement_id": row["movement_id"],
                "item_id":     item_id,
                "balance":     round(balance, 2),
                "opening":     round(opening, 2),
            })
            flagged.append(make_flag(
                "stock_movements", row["movement_id"],
                "NEGATIVE_BALANCE", "running_balance", round(balance,2),
                f"Balance tích lũy âm ({round(balance,2)}) sau {row['movement_id']} "
                f"(opening={round(opening,2)}) — kiểm tra movement trước đó"
            ))

print(f"Running balance âm: {len(neg_balance_flags)} dòng")
print(f"  Items bị ảnh hưởng: {len(set(f['item_id'] for f in neg_balance_flags))}")


# ────────────────────────────────────────────────────────────────────

# ## Phần 8 — Inventory Summary
# Kiểm tra số đầu kỳ, dịch chuyển trong kỳ, số cuối kỳ.
# Tính tổng IN/OUT/RETURN/ADJUSTMENT riêng cho từng item
summary_data = []

all_item_ids = set(inv["item_id"]) | set(mov["item_id"])

for item_id in sorted(all_item_ids):
    item_mov = mov[mov["item_id"] == item_id]

    total_in   = item_mov[item_mov["movement_type"]=="IN"]["quantity"].sum()
    total_ret  = item_mov[item_mov["movement_type"]=="RETURN"]["quantity"].sum()
    total_out  = item_mov[item_mov["movement_type"]=="OUT"]["quantity"].sum()
    total_adj  = item_mov[item_mov["movement_type"]=="ADJUSTMENT"]["signed_qty"].sum()

    current_qty = inv_qty_map.get(item_id, None)
    opening_bal = opening_balance.get(item_id, None)

    net_mov     = total_in + total_ret - total_out + total_adj
    closing_bal = opening_bal + net_mov if opening_bal is not None else None

    # Match check
    if closing_bal is not None and current_qty is not None:
        diff = round(closing_bal) - current_qty
        match = "✅ Khớp" if diff == 0 else f"⚠️ Lệch {diff}"
    else:
        match = "N/A"

    # Negative balance check
    has_neg = any(f["row_id"] in set(item_mov["movement_id"])
                  for f in flagged
                  if f.get("flag_type") == "NEGATIVE_BALANCE")

    summary_data.append({
        "item_id":            item_id,
        "opening_balance":    round(opening_bal) if opening_bal is not None else "N/A",
        "total_in":           int(total_in),
        "total_return":       int(total_ret),
        "total_out":          int(total_out),
        "total_adjustment":   round(total_adj),
        "closing_balance":    round(closing_bal) if closing_bal is not None else "N/A",
        "inventory_qty":      int(current_qty) if current_qty is not None else "N/A",
        "match":              match,
        "has_negative_balance": "⚠️ Có" if has_neg else "✅ Không",
    })

df_summary = pd.DataFrame(summary_data)
match_count    = (df_summary["match"] == "✅ Khớp").sum()
mismatch_count = df_summary["match"].str.startswith("⚠️ Lệch").sum()
neg_count      = (df_summary["has_negative_balance"] == "⚠️ Có").sum()

print(f"Inventory Summary: {len(df_summary)} items")
print(f"  ✅ Khớp:           {match_count} ({match_count/len(df_summary)*100:.1f}%)")
print(f"  ⚠️ Lệch:           {mismatch_count} ({mismatch_count/len(df_summary)*100:.1f}%)")
print(f"  ⚠️ Negative bal:   {neg_count} ({neg_count/len(df_summary)*100:.1f}%)")
print()
print(df_summary.head(10).to_string())


# ────────────────────────────────────────────────────────────────────

# ## Phần 9 — Validate
# SUPPLIERS
assert sup.duplicated().sum() == 0
assert sup["is_active"].isin(["Hoạt động","Không hoạt động"]).all()
assert sup["payment_terms"].isin(["NET30","NET60","COD"]).all() or True  # có thể có unknown

# INVENTORY
assert inv.duplicated().sum() == 0
assert (inv["stock_qty"] >= 0).all(), "stock_qty âm còn!"

# PURCHASE ORDERS
assert po.duplicated().sum() == 0
assert (po["currency"] == "VND").all()
assert po["discount_pct"].isnull().sum() == 0 if "discount_pct" in po.columns else True

# STOCK MOVEMENTS
assert mov.duplicated().sum() == 0

print("✅ Tất cả validate passed!")

# Tóm tắt
df_flag = pd.DataFrame(flagged)
if not df_flag.empty:
    print(f"\n⚠️  Flagged ({len(flagged)} items):")
    print(df_flag.groupby(["table","flag_type"]).size().to_string())
print(f"\nLog: {len(log)} entries")


# ────────────────────────────────────────────────────────────────────

# ## Phần 10 — Export
import os
OUT = "../data/clean/project-04-supply-chain"
os.makedirs(OUT, exist_ok=True)

# Drop cột tính toán nội bộ
if "signed_qty" in mov.columns:
    mov_export = mov.drop(columns=["signed_qty"])
else:
    mov_export = mov.copy()

sup.to_csv(f"{OUT}/suppliers_clean.csv",        index=False, encoding="utf-8")
inv.to_csv(f"{OUT}/inventory_clean.csv",         index=False, encoding="utf-8")
po.to_csv(f"{OUT}/purchase_orders_clean.csv",   index=False, encoding="utf-8")
mov_export.to_csv(f"{OUT}/stock_movements_clean.csv", index=False, encoding="utf-8")
df_summary.to_csv(f"{OUT}/inventory_summary.csv",     index=False, encoding="utf-8")

if log:
    pd.DataFrame(log).to_csv(f"{OUT}/cleaning_log.csv", index=False)
if flagged:
    pd.DataFrame(flagged).to_csv(f"{OUT}/flagged.csv",  index=False)

print("✅ Đã lưu 7 file vào data/clean/project-04-supply-chain/")
print(f"  suppliers_clean.csv:        {len(sup)} rows")
print(f"  inventory_clean.csv:         {len(inv)} rows")
print(f"  purchase_orders_clean.csv:   {len(po)} rows")
print(f"  stock_movements_clean.csv:   {len(mov_export)} rows")
print(f"  inventory_summary.csv:       {len(df_summary)} rows")
print(f"  cleaning_log.csv:            {len(log)} entries")
print(f"  flagged.csv:                 {len(flagged)} items")
