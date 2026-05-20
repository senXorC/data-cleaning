# 📖 Data Dictionary & Dirty Data Catalog

## Dataset 1 — sales_dirty.csv

### Mô tả cột
| Cột | Kiểu gốc | Ví dụ sạch | Vấn đề cài sẵn |
|-----|----------|------------|----------------|
| order_id | string | ORD-1001 | Có ~3% duplicate |
| date | string | 2024-03-15 | 5 format: DD/MM/YYYY, YYYY-MM-DD, DD-MM-YYYY, DD/MM/YY, MM/DD/YYYY |
| customer_id | string | C045 | ~4% null |
| product | string | Laptop Pro 15 | Sạch |
| amount | float | 25000000 | Âm (không phải returned), nhỏ bất thường (<1000), null implied |
| region | string | Hà Nội | HN/Hà Nội/Ha Noi/hà nội → 4 cách viết cho 1 khu vực |
| salesperson | string | Nguyễn Văn An | Trailing space, ALL CAPS, lowercase, ~10% null |
| status | string | completed | Sạch (completed/pending/returned/cancelled) |
| quantity | int | 2 | Sạch |
| discount_pct | float | 10.0 | ~10% null (nên fill = 0) |

### Business rules cần biết
- Chỉ tính `amount` vào doanh thu khi `status = completed`
- `amount` âm chỉ hợp lệ khi `status = returned`
- `discount_pct` null = không có chiết khấu = 0
- Đơn vị `amount` là VND (đồng)

---

## Dataset 2 — hr_employees_dirty.csv

### Mô tả cột
| Cột | Kiểu gốc | Ví dụ sạch | Vấn đề cài sẵn |
|-----|----------|------------|----------------|
| emp_id | string | EMP-2001 | ~3% duplicate |
| full_name | string | Nguyễn Văn An | ALL CAPS, lowercase, ~3% null |
| gender | string | Nam | 9 cách viết: Nam/nam/Male/M/Nữ/NỮ/Female/F/null |
| birth_year | int | 1990 | Sạch — dùng để tính lại age khi age sai |
| age | int | 34 | Tuổi 15, 150, -5, 200 — không hợp lệ |
| city | string | Hà Nội | Sạch |
| email | string | nguyenvanan@gmail.com | ~5% thiếu @, ~5% null |
| department | string | Kỹ thuật | Sạch |
| position | string | Senior Dev | Sạch |
| hire_date | string | 2022-06-15 | 3 format: DD/MM/YYYY, YYYY-MM-DD, DD-MM-YYYY |
| salary_k_vnd | float | 1500 (= 1.5 triệu) | Âm, nhân nhầm 1000 (quá lớn) |
| education | string | Đại học | đại học/ĐHỤC → không chuẩn |
| perf_score | float | 3.8 | Ngoài thang 1–5: giá trị 0, 6, 10 |
| leave_days | int | 8 | Âm, >30, null |

### Business rules cần biết
- `salary_k_vnd`: đơn vị là nghìn VND (1500 = 1,500,000 VND = 1.5 triệu)
- `age` hợp lệ: 18–65
- `perf_score` hợp lệ: 1.0–5.0
- `leave_days` hợp lệ: 0–30
- Khi `age` sai: tính lại từ `birth_year` → `2024 - birth_year`
- Khi `salary_k_vnd` > 10,000,000: nghi nhầm đơn vị → chia 1000
