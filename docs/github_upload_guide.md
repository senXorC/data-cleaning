# Hướng dẫn đưa project lên GitHub

## Bước 1 — Cài Git (nếu chưa có)
- Windows: https://git-scm.com/download/win
- Mac: `brew install git`
- Linux: `sudo apt install git`

## Bước 2 — Tạo repo trên GitHub
1. Vào https://github.com → Sign in
2. Nhấn nút **New** (dấu +)
3. Đặt tên repo: `data-cleaning-project`
4. Chọn **Public** (để portfolio)
5. KHÔNG tick "Add README" (vì đã có sẵn)
6. Nhấn **Create repository**
7. Copy URL dạng: `https://github.com/TÊN_BẠN/data-cleaning-project.git`

## Bước 3 — Khởi tạo Git trong thư mục project
Mở Terminal / Command Prompt, cd vào thư mục project:

```bash
cd đường/dẫn/tới/data-cleaning-project

git init
git add .
git commit -m "Initial commit: Sales & HR raw data + cleaning scripts"
git branch -M main
git remote add origin https://github.com/TÊN_BẠN/data-cleaning-project.git
git push -u origin main
```

## Bước 4 — Các commit tiếp theo (workflow hàng ngày)
```bash
# Sau khi sửa code hoặc thêm file
git add .
git commit -m "Mô tả ngắn thay đổi bạn làm"
git push
```

## Gợi ý đặt tên commit
- `Add sales cleaning script with outlier detection`
- `Fix: handle multiple date formats in sales data`
- `Add HR salary validation logic`
- `Update README with error catalog`

## Cấu trúc GitHub repo gợi ý
Sau khi upload, repo sẽ hiển thị:
- 📄 README.md (tự động render đẹp trên GitHub)
- 📁 data/raw/ — 2 file CSV thực hành
- 📁 python/scripts/ — 2 file .py
- 📁 google-apps-script/ — 2 file .gs
- 📁 docs/
