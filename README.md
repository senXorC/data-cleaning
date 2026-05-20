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
│   │   └── orders_dirty.csv
│   │
│   └── clean/                        ← Output sau khi làm sạch
│       ├── project-01-sales/
│       ├── project-02-hr/
│       └── project-03-ecommerce/
│
├── python/
│   ├── project-01-sales/
│   │   └── 01_sales_cleaning.py
│   ├── project-02-hr/
│   │   └── 02_hr_cleaning.py
│   └── project-03-ecommerce/
│       └── 03_ecommerce_cleaning.ipynb
│       └── 03_ecommerce_cleaning.py
│
├── google-apps-script/
│   ├── project-01-sales/
│   │   └── 01_sales_cleaning_final.gs
│   ├── project-02-hr/
│   │   └── 02_hr_cleaning.gs
│   └── project-03-ecommerce/
│       ├── 03_ecommerce_customers.gs
│       ├── 03_ecommerce_products.gs
│       └── 03_ecommerce_orders.gs
│
└── docs/
    └── data_dictionary.md
```

---

## 🗺️ Lộ trình học

```
Project 01 — Sales & HR        ✅ Hoàn thành
Project 02 — HR Employees      ✅ Hoàn thành
Project 03 — E-commerce        ✅ Hoàn thành
Project 04 — Healthcare        🔜 Sắp tới
Project 05 — IoT Sensor        🔜 Sắp tới
Project 06 — Financial         🔜 Sắp tới
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

## 📊 Project 01 — Sales & 02 - HR

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
- 📋 [Customers Cleaning](https://docs.google.com/spreadsheets/d/1Az5TJslLFpjIHX1JIMVbWb2OxQH0_iKe2aFakoTvVLM/edit?gid=2026485316#gid=2026485316)
- 📦 [Products Cleaning](https://docs.google.com/spreadsheets/d/1swcJpAeUNpSxNbACNyM1i8fmBK9ErxKc3O1JTATNurE/edit?gid=1912405573#gid=1912405573)
- 🛍️ [Orders Cleaning](https://docs.google.com/spreadsheets/d/1LJNFW25kYs-CjTatCwIbw6wYKCF29bLOdMa4MeK3OWQ/edit?gid=91633045#gid=91633045)

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
5. Copy **Spreadsheet ID** từ URL: `https://docs.google.com/spreadsheets/d/[**ID_NÀY**]/edit`

**Bước 2 — Products:**
1. Tạo Spreadsheet mới → import `data/raw/products_dirty.csv`
2. Đặt tên sheet là `products_dirty`
3. Paste `google-apps-script/project-03-ecommerce/03_ecommerce_products.gs`
4. Run **`runProductsCleaning()`**
5. Copy **Spreadsheet ID**

**Bước 3 — Orders:**
1. Tạo Spreadsheet mới → import `data/raw/orders_dirty.csv`
2. Đặt tên sheet là `orders_dirty`
3. Paste `google-apps-script/project-03-ecommerce/03_ecommerce_orders.gs`
4. **Điền 2 ID vào đầu file trước khi chạy:**
```javascript
const CUSTOMERS_SPREADSHEET_ID = "ID_từ_bước_1";
const PRODUCTS_SPREADSHEET_ID  = "ID_từ_bước_2";
```
5. Run **`runOrdersCleaning()`**
6. Kết quả: sheet **orders_clean**, **Cleaning_Log**, **Flagged**

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

**Các action phổ biến:**

```
DROPPED_DUPLICATE       — Xóa dòng trùng
DATE_NORMALIZED         — Chuẩn hoá format ngày
GENDER_NORMALIZED       — Chuẩn hoá giới tính
NAME_NORMALIZED         — Title case tên
REGION_NORMALIZED       — Chuẩn hoá tên vùng
EMAIL_DIACRITIC_REMOVED — Bỏ dấu phần local email
EMAIL_AT_INSERTED       — Thêm @ vào email thiếu
PHONE_NORMALIZED        — Chuẩn hoá số điện thoại
TIER_NORMALIZED         — Chuẩn hoá membership tier
SALARY_NEGATIVE_NULLED  — Lương âm → null
AGE_RECALCULATED        — Tính lại age từ birth_year
PERF_FILLED_MEDIAN      — Fill median cho perf_score
STOCK_NEGATIVE_ZEROED   — Stock âm → 0
CURRENCY_FIXED          — Đổi currency flag USD → VND
TOTAL_RECALCULATED      — Tính lại total từ unit_price × qty
ADDRESS_FIXED           — Tự sửa JSON broken (thiếu })
HIRE_BEFORE_BIRTH       — hire_date trước birth_year (cross-column)
ORPHAN_ORDER            — Order có FK không tồn tại (referential integrity)
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

---

## 🛠️ Tech Stack

| Công cụ | Dùng khi |
|---------|---------|
| **Python + pandas** | Dữ liệu từ file CSV, database, API |
| **Google Apps Script** | Dữ liệu nhập tay trong Google Sheets |
| **Jupyter Notebook** | Ghi chép tư duy + code + output trong 1 file |

---

*Tác giả: Đang học Data Analytics · 2025*
