# Translate Hover

Bôi đen (select) đoạn text bất kỳ trong editor → hiện icon 🌐 ngay sau vùng chọn → rê chuột vào để xem bản dịch Google Translate trong popup, giống extension Google Dịch trên Chrome.

## Dùng như thế nào

| Thao tác | Kết quả |
|---|---|
| Select text rồi rê chuột vào vùng chọn | Popup dịch hiện ra |
| `Cmd+Alt+T` (mac) / `Ctrl+Alt+T` | Mở popup dịch ngay, không cần rê chuột |
| `Cmd+Alt+Shift+T` / `Ctrl+Alt+Shift+T` | Dịch và **thay thế** luôn đoạn đang chọn |
| Click ngôn ngữ ở status bar (`🌐 auto → vi`) | Đổi ngôn ngữ đích |
| Chuột phải vào vùng chọn | Menu Translate |

Trong popup có sẵn: 🔊 nghe phát âm, Copy, Replace, và **More »** để mở translate.google.com.

## Đổi ngôn ngữ ngay trong popup

Không cần mở Settings:

- Click vào **tên ngôn ngữ nguồn** (trái) hoặc **đích** (phải) ngay trên đầu popup → quick pick hiện ra, chọn xong popup tự dịch lại và bung ra lại.
- Hàng shortcut dưới bản dịch (`vi · en · ja · zh-CN`) đổi ngôn ngữ đích chỉ bằng một click. Sửa danh sách này ở `translateHover.quickLanguages`.
- Nút ⇄ đảo chiều nguồn ↔ đích.
- Ngôn ngữ vừa dùng được đẩy lên đầu quick pick lần sau.
- Chọn **Detect language** ở picker nguồn để quay về `auto`; khi đang auto, popup hiển thị ngôn ngữ Google nhận ra kèm chữ `(auto)`.

## Cấu hình

Tất cả nằm dưới `translateHover.*` trong Settings:

- `targetLanguage` — mặc định `vi`
- `sourceLanguage` — mặc định `auto`
- `quickLanguages` — các mã ngôn ngữ hiện thành shortcut một-click trong popup (mặc định `vi, en, ja, zh-CN`; để `[]` để ẩn hàng này)
- `showIconOnSelect` — hiện icon 🌐 sau vùng chọn (mặc định bật)
- `autoShowPopup` — tự bung popup ngay khi select, khỏi cần rê chuột (mặc định tắt)
- `autoShowDelay` — độ trễ debounce, ms (mặc định 350)
- `hoverOnWord` — rê chuột lên một từ là dịch, không cần select (mặc định tắt)
- `stripCommentMarkers` — bỏ `//`, `/* */`, `#`, `<!-- -->` trước khi dịch (mặc định bật)
- `maxLength` — số ký tự tối đa gửi đi (mặc định 2000)
- `apiKey` — API key Google Cloud Translation. Để trống thì dùng endpoint miễn phí.
- `proxy` — thay `clients5.google.com` bằng host khác nếu bị chặn.

## Về endpoint dịch

Mặc định extension gọi `clients5.google.com/translate_a/t` — đúng endpoint mà Google Translate Chrome extension dùng. Đây là API **không chính thức**: miễn phí, không cần key, nhưng có rate limit và Google có thể đổi bất cứ lúc nào. Nếu bị `HTTP 429`, extension tự thử tiếp `translate.googleapis.com`; muốn ổn định lâu dài thì điền `translateHover.apiKey` để dùng Cloud Translation API chính thức (có tính phí).

## Phát triển

```bash
npm install
npm run compile     # hoặc: npm run watch
```

Mở thư mục này trong VS Code rồi nhấn `F5` để bật Extension Development Host.

Đóng gói:

```bash
npx @vscode/vsce package
code --install-extension translate-hover-0.0.1.vsix
```

## Giới hạn đã biết

VS Code không cho vẽ popup HTML tùy ý tại vị trí con trỏ như Chrome extension làm. Popup ở đây là **Hover API** native của editor, render Markdown — nên không có dropdown chọn ngôn ngữ ngay trong popup (dùng status bar hoặc icon ⚙️ thay thế), và nút 🔊 mở audio TTS bằng trình duyệt ngoài chứ không phát trực tiếp trong editor.

Icon 🌐 hiển thị được nhưng **không click được** — decoration của VS Code không nhận sự kiện click. Rê chuột vào là ra popup.
