# Đối chiếu agent được cung cấp — Studio 0.3.1

Đối chiếu `agent.zip` của người dùng với Studio 0.3 (commit `8a0fe38`).
Đã bỏ khác biệt CRLF/LF và UTF-8 BOM trước khi so sánh nội dung Python/JSON.
Không chép cache Python hoặc `models.json.backup` vào bản chạy.

## Kết quả

| File | Khác biệt thực tế | Xử lý |
| --- | --- | --- |
| `agent/api/flow.py` | Giống nhau | Giữ nguyên |
| `agent/services/flow_client.py` | Giống nhau | Giữ nguyên |
| `agent/worker/processor.py` | Giống nhau | Giữ nguyên |
| `agent/services/flow_batch.py`, `agent/services/omni_flash.py` | Giống nhau | Giữ nguyên |
| `agent/models.json` | Bản gửi dùng `abra_i2v_6s` và `abra_r2v_6s` trong `video_models` cho cả hai tier/hướng | Đồng bộ đúng cấu hình được gửi |
| `agent/services/video_reviewer.py` | Bản gửi có fallback copy khi Windows không cho tạo symlink và xử lý đường dẫn trong prompt | Ghép các sửa đổi này; giữ cơ chế hủy tiến trình và khởi chạy CLI Windows đã có trong Studio |
| `agent/db/crud.py`, `agent/models/scene.py`, `agent/sdk/persistence/sqlite_repository.py` | Studio có thêm `narrator_text` | Giữ phần mở rộng Studio |
| `agent/db/schema.py` | Studio khởi tạo thêm schema storyboard | Giữ phần mở rộng Studio |
| `agent/main.py` | Studio có router/worker desktop, storyboard và xử lý shutdown | Giữ phần mở rộng Studio |
| `extension/background.js` | Không có trong ZIP | Chưa thể đối chiếu |

Ngoài các file được liệt kê là khác ở trên, những file source chung giữa hai
thư mục agent không có khác biệt nội dung sau chuẩn hóa xuống dòng/BOM.

## Ý nghĩa đối với Text to Image / Text to Video

- Text to Image trên Electron gọi `flow.generate_image()` rồi
  `FlowClient.generate_images()`. Cấu hình image model trong hai bản giống nhau.
- Text to Video trên Electron gọi `flow.generate_video_omni_text()` rồi
  `generate_omni_flash_text_video()`. Luồng này dựng model `abra_t2v_{duration}s`
  theo thời lượng được chọn, độc lập với bảng `video_models` vừa đồng bộ.
- Các luồng video cũ dùng `FlowClient._batch_video_model()` vẫn đi qua
  `flow_batch.resolve_video_model()`. Hàm này chỉ chấp nhận các model Veo batch;
  tên `abra_*` trong bảng `video_models` sẽ được quy về mặc định
  `veo_3_1_i2v_lite_low_priority`. Đây cũng là hành vi trong agent được gửi.
  Việc đồng bộ JSON không đồng nghĩa đã chuyển các luồng cũ sang Omni.
- Vì các file generation chính giống nhau, chưa có bằng chứng rằng khác biệt
  agent là nguyên nhân làm một bản tạo được ảnh/video còn bản kia không tạo được.
  Cần đối chiếu thêm extension đang hoạt động của người dùng.

## Kiểm tra

- `python -m pytest tests/unit -q`: **421 passed**.
- `cd desktop && npm run check`: đạt kiểm tra cú pháp.
- `cd desktop && npm test`: **7 passed**.
- Regression mới: giả lập Windows từ chối symlink, kiểm tra nội dung frame được
  copy chính xác và tạo contact sheet bằng FFmpeg thật; kiểm tra đường dẫn
  POSIX, Windows có dấu cách và UNC.
- Những kiểm tra generation sử dụng response giả lập. Chưa kiểm tra tạo
  ảnh/video thật trên Google Flow hoặc chạy giao diện Electron trên Windows.

## Cập nhật

Nếu đang dùng Studio 0.3, giải nén gói `flowkit-studio-v0.3.1-update.zip` vào
thư mục gốc Flowkit, chấp nhận ghi đè các file có trong gói. Gói cập nhật không
có extension, database, `.env`, output hay node_modules. Nó chỉ áp dụng cho
Studio 0.3, không phải bản cài đặt đầy đủ cho repo gốc.

Gói `flowkit-electron-studio-v0.3.1.zip` là toàn bộ source của Studio. Nếu dùng
gói này, giữ lại extension đang chạy tốt của bạn; thư mục extension trong gói
đầy đủ chưa được đối chiếu với phiên bản bạn đã chỉnh sửa. Giữ lại cấu hình,
database và dữ liệu hiện có. Đóng ứng dụng trước khi cập nhật rồi chạy lại bằng
`start_desktop.bat` (chạy `setup_desktop.bat` nếu đây là lần cài đặt đầu tiên).

Để hoàn tất đối chiếu, cần gửi thêm `extension/background.js` hoặc cả
`extension.zip` của phiên bản đang tạo ảnh/video thành công.
