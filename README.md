# 退撫與年金指標儀表板

整合 OECD 國際比較資料與國內開放資料（退撫基金、勞保、國保、公保、老農津貼等）的 HTML 儀表板，部署於 GitHub Pages。

## 使用方式

- **瀏覽**：開啟 GitHub Pages 網址（或本機直接開 `dashboard.html`）。圖表元件 Chart.js 與匯出元件 JSZip 由 cdnjs 載入，需連網。
- **更新資料**：按頁首「更新資料」。
  - 線上版：會帶到 GitHub Actions 的「更新資料」流程，按 **Run workflow**（需具 repo 寫入權限），約 3–5 分鐘後重新整理頁面。另每天 06:00（臺灣時間）自動更新一次。
  - 本機版：雙擊 `一鍵更新資料.bat`（瀏覽器無法直接執行本機程式）。
- **匯出**：每張卡片右上角「匯出 Excel」，或頁首「匯出全部 Excel」。匯出檔內的圖表是 Excel 原生圖表，數列直接引用工作表儲存格，可在 Excel 中編輯。

## 分頁

| 分頁 | 內容 |
|---|---|
| 退撫與退休基金 | 四大基金收益率與規模、退撫參加人數、收繳撥付、年改挹注、公保養老給付、國發會跨制度統計 |
| 社會保險費率與津貼 | 公保與國保費率、國保／勞保老年年金平均月領、各制度老年給付月額比較、勞保投保薪資上下限、老農津貼核付人數 |
| OECD 國際比較 | 所得替代率、法定與實際退休年齡、老年貧窮率、公共年金支出、退休準備資產（OECD 不含臺灣） |
| 跨指標比較 | 任選最多 8 條時間序列，以指數化、年增率或原始值比較；點選數列標籤可顯示或隱藏 |
| 人工確認參數 | 無法自動取得的數值（退撫提撥費率、老農津貼月額、勞保費率沿革、勞保年金平均月領等），附確認路徑 |
| 資料來源與更新 | 各來源狀態、每年度新資料集的自動搜尋結果、查詢連結與手動新增入口 |

## 自動處理機制

- **每年度新開的資料集**（退撫每月／年度經營概況）：每次更新會用 data.gov.tw 搜尋自動找到並併入新年度，不需手動加編號。若搜尋失敗，可在「資料來源與更新」頁用查詢連結找到編號，再在 GitHub 編輯 `config/sources.json` 加入。
- **機關原始網址被擋**（例如臺灣銀行公保資料有機器人驗證）：自動改用 data.gov.tw 平台的轉檔副本（非即時），並在來源頁標示。
- **下載失敗**：沿用上次成功的資料（存在 `data/raw/`）並標示。OECD API 有流量限制，短時間內重複更新可能被暫時拒絕。
- **累積型來源**：`np_benefit`（國保年金給付，資料集 13348）每次只提供最新月份，每次更新會累積到 `data/raw/`，所以 `data/raw/` 必須保留在 repo 中。

## 人工確認參數

在儀表板修改後只存在各自的瀏覽器。要讓所有人看到：按「匯出確認結果」另存 `manual.json` → 在 GitHub 上傳覆蓋 `config/manual.json` → 執行一次「更新資料」。

## 首次部署設定（repo 管理員）

1. repo **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
2. repo **Settings → Actions → General → Workflow permissions** 選 **Read and write permissions**（讓流程能提交更新後的資料）。
3. 到 **Actions → 更新資料 → Run workflow** 執行第一次。
4. 私人 repo 使用 GitHub Pages 需組織為 GitHub Team／Enterprise 方案。

## 檔案結構

```
dashboard.html                    儀表板（單一檔案；Pages 發布為 index.html）
一鍵更新資料.bat                    本機更新
scripts/update.ps1                下載與建置腳本（Windows PowerShell 5.1；GitHub 上以 windows-latest 執行）
config/sources.json               資料來源清單
config/manual.json                人工確認參數預設值
data/raw/                         各來源最近一次成功下載的原始 CSV（快取，需保留）
data/data.js                      儀表板讀取的資料檔（由腳本產生）
.github/workflows/update-data.yml 更新資料與發布 Pages 的流程
```
