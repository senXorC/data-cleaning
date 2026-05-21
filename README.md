# 🧹 Data Cleaning Projects

Chuỗi project thực hành **làm sạch dữ liệu** từ cơ bản đến nâng cao, xây dựng nền tảng vững chắc trước khi học EDA → SQL → Data Modeling → ETL Pipeline.

Mỗi project được xử lý bằng **2 pipeline song song:**
- **Python/pandas** — cho dữ liệu từ file, database, API
- **Google Apps Script** — cho dữ liệu nhập tay trong Google Sheets

---

## 📁 Cấu trúc thư mục

```
data-cleaning-projects/
│
├── data/
│   ├── raw/                          ← Dữ liệu gốc — KHÔNG chỉnh sửa
│   │   ├── sales_dirty.csv
│   │   ├── hr_dirty.csv
│   │   ├── customers_dirty.csv
│   │   ├── products_dirty.csv
│   │   ├── orders_dirty.csv
│   │   ├── suppliers_dirty.csv
│   │   ├── inventory_dirty.csv
│   │   ├── purchase_orders_dirty.csv
│   │   └── stock_movements_dirty.csv
│   │
│   └── clean/                        ← Output sau khi làm sạch
│       ├── project-01-sales/
│       ├── project-02-hr/
│       ├── project-03-ecommerce/
│       └── project-04-supply-chain/
│
├── python/
│   ├── project-01-sales/
│   │   └── 01_sales_cleaning.py
│   ├── project-02-hr/
│   │   └── 02_hr_cleaning.py
│   ├── project-03-ecommerce/
│   │   ├── 02_ecommerce_cleaning.ipynb
│   │   └── 02_ecommerce_cleaning.py
│   └── project-04-supply-chain/
│       ├── 04_supply_chain_cleaning.ipynb
│       └── 04_supply_chain_cleaning.py
│
├── google-apps-script/
│   ├── project-01-sales/
│   │   └── 01_sales_cleaning_final.gs
│   ├── project-02-hr/
│   │   └── 02_hr_cleaning.gs
│   ├── project-03-ecommerce/
│   │   ├── 03_ecommerce_customers.gs
│   │   ├── 03_ecommerce_products.gs
│   │   └── 03_ecommerce_orders.gs
│   └── project-04-supply-chain/
│       ├── 04_suppliers_cleaning.gs
│       ├── 04_inventory_cleaning.gs
│       ├── 04_purchase_orders_cleaning.gs
│       └── 04_stock_movements_cleaning.gs
│
└── docs/
    ├── data_dictionary.md
    └── project-04-supply-chain.md
```

---

## 🗺️ Lộ trình học

```
Project 01 — Sales & HR        ✅ Hoàn thành
Project 02 — HR Employees      ✅ Hoàn thành
Project 03 — E-commerce        ✅ Hoàn thành
Project 04 — Supply Chain      ✅ Hoàn thành
Project 05 — Finance           🔜 Sắp tới
Project 06 — Multi-source      🔜 Sắp tới
                ↓
            EDA + Visualization
                ↓
            SQL + Database
                ↓
            Data Modeling
                ↓
            ETL Pipeline
                ↓
        Báo cáo tự động
```

---

## 📊 Project 01 — Sales & HR

**Dataset:** `sales_dirty.csv` (~300 rows) · `hr_dirty.csv` (~200 rows)

**Kỹ năng thực hành:**
- Parse date 5 format khác nhau (DD/MM/YYYY, YYYY-MM-DD, DD-MM-YYYY, DD/MM/YY, MM/DD/YYYY)
- Cross-column validation: amount × status, age × birth_year, hire_date × birth_year
- Normalize text: region 16 cách viết → 5 chuẩn, gender 9 cách viết → Nam/Nữ
- Title case Unicode tiếng Việt (không dùng `\b\w` vì không nhận ký tự đặc biệt)
- Cleaning log đầy đủ 5 trường: row_original, field, old_value, new_value, action
- Tách HR_Flagged riêng: không để flag trong bảng clean

**Vấn đề đặc biệt:**
- GAS: `new Date()` gây lệch ngày do timezone → phải dùng `Date.UTC()`
- GAS: Sheets parse `"2.0"` thành Date object → cần `readPerfScore()` detect `instanceof Date`
- Python: `str.title()` sai Unicode → dùng `split + capitalize`

---

## 🛒 Project 03 — E-commerce (Multi-table)

**Dataset:** `customers_dirty.csv` (150 rows) · `products_dirty.csv` (50 rows) · `orders_dirty.csv` (500 rows)

**Kỹ năng mới so với Project 01:**

| Kỹ năng | Mô tả |
|---------|-------|
| **Multi-table** | Làm sạch 3 bảng có quan hệ, đúng thứ tự: master data trước |
| **Referential Integrity** | Phát hiện order có customer_id/product_id không tồn tại |
| **JSON parsing** | Parse cột `shipping_address` dạng JSON, tự sửa broken JSON (thiếu `}`) |
| **Currency** | Detect USD nhầm → chỉ đổi flag, để pipeline tính lại total |
| **Phone** | Chuẩn hoá +84/84/9 số → 10 số chuẩn Việt Nam |

**Vấn đề đặc biệt:**
- GAS: `weight_kg` bị Sheets parse thành Date object → reconstruct từ ngày.tháng
- GAS: `#NUM!` do unit_price là Date object → `safeNumber()` helper
- Python: format `D/M/YYYY` (không có số 0) → regex `\d{1,2}` thay vì `\d{2}`

**Google Sheets public links:**
- 📋 [Customers Cleaning](PASTE_CUSTOMERS_SHEET_URL_HERE)
- 📦 [Products Cleaning](PASTE_PRODUCTS_SHEET_URL_HERE)
- 🛍️ [Orders Cleaning](PASTE_ORDERS_SHEET_URL_HERE)

---

## 📦 Project 04 — Supply Chain & Inventory

**Dataset:** `suppliers_dirty.csv` (50) · `inventory_dirty.csv` (80) · `purchase_orders_dirty.csv` (300) · `stock_movements_dirty.csv` (1,000)  
**Tổng rows:** 1,430 · **Quan hệ:** 4 bảng liên kết nhau theo chuỗi

**Quan hệ giữa các bảng:**
```
suppliers → inventory → purchase_orders → stock_movements
```

**Kỹ năng mới so với Project 03:**

| Kỹ năng | Mô tả |
|---------|-------|
| **Running Balance** | Tính tồn kho tích lũy theo thời gian. Bắt đầu từ `opening_balance` (tính ngược từ inventory) thay vì 0 — tránh false positive |
| **Bộ 3 cross-column** | `stock_qty / reorder_point / max_stock` ràng buộc lẫn nhau — mỗi vi phạm có hậu quả nghiệp vụ khác nhau |
| **Fuzzy Deduplication** | Phát hiện tên NCC gần giống. Python: `thefuzz.ratio ≥ 90`. GAS: normalize + exact match |
| **Inventory Summary** | Sheet đối soát đầu kỳ/cuối kỳ: opening + in + return - out + adj = closing |
| **payment_terms keyword** | 14 cách viết → keyword matching "30/60/cod" → NET30/NET60/COD |
| **is_active boolean** | Sheets parse TRUE/FALSE thành JavaScript boolean → phải dùng `typeof` |

**Bài học quan trọng nhất:**
- ADJUSTMENT qty âm = kiểm kê thiếu hàng → hợp lệ, không phải lỗi
- Tên cột `unit_cost_vnd` là contract → không nhân × 25,000 dù currency = USD
- Running balance từ 0 → false positive → luôn tính opening balance trước

**Google Sheets public links:**
- 🏭 [Suppliers Cleaning](PASTE_SUPPLIERS_SHEET_URL)
- 📦 [Inventory Cleaning](PASTE_INVENTORY_SHEET_URL)
- 🛒 [Purchase Orders Cleaning](PASTE_PO_SHEET_URL)
- 🚚 [Stock Movements Cleaning](PASTE_MOVEMENTS_SHEET_URL)

---

## 🚀 Hướng dẫn chạy

### Python

```bash
# Cài thư viện
pip install pandas numpy

# Project 01 — Sales
cd python/project-01-sales
python 01_sales_cleaning.py

# Project 02 — HR
cd python/project-02-hr
python 02_hr_cleaning.py

# Project 03 — E-commerce (Jupyter Notebook)
cd python/project-03-ecommerce
jupyter lab
# Mở file 02_ecommerce_cleaning.ipynb
# Kernel → Restart Kernel and Run All Cells

# Project 04 — Supply Chain (Jupyter Notebook)
pip install thefuzz python-Levenshtein
cd python/project-04-supply-chain
jupyter lab
# Mở file 04_supply_chain_cleaning.ipynb
# Kernel → Restart Kernel and Run All Cells
```

### Google Apps Script

#### Project 01 — Sales
1. Vào [sheets.google.com](https://sheets.google.com) → tạo Spreadsheet mới
2. **File → Import** → upload `data/raw/sales_dirty.csv`
3. **Extensions → Apps Script** → paste toàn bộ nội dung `google-apps-script/project-01-sales/01_sales_cleaning_final.gs`
4. Chọn function **`runSalesCleaning()`** → **Run**
5. Cấp quyền nếu được hỏi lần đầu
6. Kết quả: sheet **Sales_Clean** và **Cleaning_Log**

#### Project 02 — HR
1. Tạo Spreadsheet mới → import `data/raw/hr_dirty.csv`
2. Paste nội dung `google-apps-script/project-02-hr/02_hr_cleaning.gs`
3. Run **`runHRCleaning()`**
4. Kết quả: sheet **HR_Clean**, **HR_Log**, **HR_Flagged**

#### Project 03 — E-commerce (3 file riêng biệt)

> ⚠️ **Chạy theo đúng thứ tự:** Customers → Products → Orders

**Bước 1 — Customers:**
1. Tạo Spreadsheet mới → import `data/raw/customers_dirty.csv`
2. Đặt tên sheet là `customers_dirty`
3. Paste `google-apps-script/project-03-ecommerce/03_ecommerce_customers.gs`
4. Run **`runCustomersCleaning()`**
5. Copy **Spreadsheet ID** từ URL: `https://docs.google.com/spreadsheets/d/[ID]/edit`

**Bước 2 — Products:**
1. Tạo Spreadsheet mới → import `data/raw/products_dirty.csv`
2. Đặt tên sheet là `products_dirty`
3. Paste `03_ecommerce_products.gs` → Run **`runProductsCleaning()`**
4. Copy **Spreadsheet ID**

**Bước 3 — Orders:**
1. Tạo Spreadsheet mới → import `data/raw/orders_dirty.csv`
2. Đặt tên sheet là `orders_dirty`
3. Paste `03_ecommerce_orders.gs`
4. Điền 2 ID vào đầu file:
```javascript
const CUSTOMERS_SPREADSHEET_ID = "ID_từ_bước_1";
const PRODUCTS_SPREADSHEET_ID  = "ID_từ_bước_2";
```
5. Run **`runOrdersCleaning()`**

#### Project 04 — Supply Chain (4 file, chạy theo thứ tự)

> ⚠️ **Bắt buộc chạy đúng thứ tự:** Suppliers → Inventory → Purchase Orders → Stock Movements

**Bước 1 — Suppliers:**
1. Tạo Spreadsheet mới → import `data/raw/suppliers_dirty.csv`
2. Đặt tên sheet là `suppliers_dirty`
3. Paste `google-apps-script/project-04-supply-chain/04_suppliers_cleaning.gs`
4. Run **`runSuppliersCleaning()`**
5. Copy **Spreadsheet ID** từ URL

**Bước 2 — Inventory:**
1. Tạo Spreadsheet mới → import `data/raw/inventory_dirty.csv`
2. Đặt tên sheet là `inventory_dirty`
3. Paste `04_inventory_cleaning.gs`
4. Điền `SUPPLIERS_SPREADSHEET_ID` vào đầu file
5. Run **`runInventoryCleaning()`** → Copy **Spreadsheet ID**

**Bước 3 — Purchase Orders:**
1. Tạo Spreadsheet mới → import `data/raw/purchase_orders_dirty.csv`
2. Đặt tên sheet là `purchase_orders_dirty`
3. Paste `04_purchase_orders_cleaning.gs`
4. Điền 2 ID vào đầu file:
```javascript
const PO_SUPPLIERS_SPREADSHEET_ID = "ID_từ_bước_1";
const PO_INVENTORY_SPREADSHEET_ID = "ID_từ_bước_2";
```
5. Run **`runPurchaseOrdersCleaning()`** → Copy **Spreadsheet ID**

**Bước 4 — Stock Movements:**
1. Tạo Spreadsheet mới → import `data/raw/stock_movements_dirty.csv`
2. Đặt tên sheet là `stock_movements_dirty`
3. Paste `04_stock_movements_cleaning.gs`
4. Điền 2 ID vào đầu file:
```javascript
const MOV_PO_SPREADSHEET_ID        = "ID_từ_bước_3";
const MOV_INVENTORY_SPREADSHEET_ID = "ID_từ_bước_2";
```
5. Run **`runStockMovementsCleaning()`**
6. Xem sheet **Inventory_Summary** để đối soát tồn kho đầu/cuối kỳ

---

## 📋 Cleaning Log — Cấu trúc chuẩn

Mọi thay đổi đều được ghi lại với **5 trường** nhất quán giữa Python và GAS:

| Trường | Ý nghĩa | Ví dụ |
|--------|---------|-------|
| `row_original` | Số hàng trong file gốc (bắt đầu từ 2) | `5` |
| `field` | Cột bị thay đổi | `gender` |
| `old_value` | Giá trị trước khi sửa | `male` |
| `new_value` | Giá trị sau khi sửa | `Nam` |
| `action` | Loại xử lý | `GENDER_NORMALIZED` |

**Các action đầy đủ theo từng project:**

```
# Project 01-02
DROPPED_DUPLICATE       — Xóa dòng trùng
DATE_NORMALIZED         — Chuẩn hoá format ngày
GENDER_NORMALIZED       — Chuẩn hoá giới tính
NAME_NORMALIZED         — Title case tên
REGION_NORMALIZED       — Chuẩn hoá tên vùng
EMAIL_DIACRITIC_REMOVED — Bỏ dấu phần local email
EMAIL_AT_INSERTED       — Thêm @ vào email thiếu
PHONE_NORMALIZED        — Chuẩn hoá số điện thoại
SALARY_NEGATIVE_NULLED  — Lương âm → null
HIRE_BEFORE_BIRTH       — hire_date trước birth_year (cross-column)

# Project 03
STOCK_NEGATIVE_ZEROED   — Stock âm → 0
CURRENCY_FIXED          — Đổi currency flag USD → VND
TOTAL_RECALCULATED      — Tính lại total từ unit_price × qty
ADDRESS_FIXED           — Tự sửa JSON broken (thiếu })
ORPHAN_ORDER            — Order có FK không tồn tại

# Project 04
PAYMENT_TERMS_NORMALIZED — 14 cách viết → NET30/NET60/COD
IS_ACTIVE_NORMALIZED     — TRUE/1/False → Hoạt động/Không hoạt động
LOCATION_FILLED          — warehouse_location null → Không xác định
WAREHOUSE_FILLED         — warehouse null → Không xác định
TYPE_NORMALIZED          — movement_type 22 cách viết → 4 loại chuẩn
QTY_SIGN_FIXED           — qty âm trong IN/OUT/RETURN → abs()
QTY_NEGATIVE_ADJUSTMENT_VALID — ADJUSTMENT âm hợp lệ (kiểm kê thiếu)
REORDER_GT_MAX           — reorder_point ≥ max_stock (FLAG)
STOCK_EXCEED_MAX         — stock_qty > max_stock (FLAG)
NEGATIVE_BALANCE         — Running balance âm (FLAG)
ORPHAN_PO                — PO có FK không tồn tại
ORPHAN_REF_PO            — reference_po không tồn tại trong PO
EXPECTED_BEFORE_ORDER    — expected_date trước order_date (cross-column)
FUZZY_DUPLICATE          — Tên NCC gần giống nhau
```

---

## 💡 Nguyên tắc xử lý dữ liệu

**1. Không bao giờ sửa file gốc**
Luôn làm việc trên bản copy. File raw là nguồn sự thật duy nhất.

**2. Cleaning vs EDA**
- Cleaning: sửa lỗi kỹ thuật (null, format, duplicate, cross-column)
- EDA: quyết định xử lý outlier (winsorize/exclude) dựa trên phân phối

**3. Flag thay vì tự ý sửa**
Khi không chắc chắn → flag vào bảng Flagged. Sửa sai còn tệ hơn để nguyên.

**4. null vs 0**
`null` = "không biết" · `0` = "bằng không" — khác nhau hoàn toàn về nghĩa nghiệp vụ.

**5. Tách Flagged khỏi Clean**
Analyst dùng bảng Clean để phân tích → không nên thấy cột flag. Flagged là bảng riêng cho người review.

**6. Nghiệp vụ quyết định kỹ thuật**
Cùng 1 vấn đề kỹ thuật (qty âm) nhưng context khác nhau → xử lý khác nhau.
ADJUSTMENT âm = kiểm kê thiếu hàng → hợp lệ. IN âm = nhập sai dấu → sửa.

**7. Tên cột là contract**
`unit_cost_vnd` đã có "vnd" trong tên → không nhân × 25,000 dù currency = USD.
Tên cột là cam kết về đơn vị — tin vào tên cột hơn tin vào giá trị cột khác.

---

## 🛠️ Tech Stack

| Công cụ | Dùng khi |
|---------|---------|
| **Python + pandas** | Dữ liệu từ file CSV, database, API |
| **Google Apps Script** | Dữ liệu nhập tay trong Google Sheets |
| **Jupyter Notebook** | Ghi chép tư duy + code + output trong 1 file |
| **thefuzz** | Fuzzy string matching cho deduplication |

---

*Tác giả: Đang học Data Analytics · 2024*
