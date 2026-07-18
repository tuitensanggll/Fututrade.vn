// =====================================================================
// VN-STOCK.JS — Chế độ "Chứng khoán Việt Nam" (song song với Crypto)
// ---------------------------------------------------------------------
// File này HOÀN TOÀN TÁCH BIỆT khỏi script.js (không đụng vào biến/hàm
// của engine crypto) để không làm ảnh hưởng tới phần Crypto đang chạy.
//
// NGUỒN DỮ LIỆU: API công khai (không cần đăng nhập) của TCBS, được cộng
// đồng lập trình viên chứng khoán Việt Nam (vnstock, v.v...) dùng phổ biến
// để lấy dữ liệu nến lịch sử. Đây KHÔNG PHẢI API chính thức của DNSE.
//
// GHI CHÚ QUAN TRỌNG CHO BẠN (chủ web):
//  - Đây là bước 1: xem giá & biểu đồ tham khảo, không cần backend.
//  - DNSE Lightspeed OpenAPI (https://developers.dnse.com.vn) là API CHÍNH
//    THỨC, cho dữ liệu real-time chuẩn + đặt lệnh thật qua tài khoản DNSE
//    của bạn — nhưng bắt buộc phải có backend riêng để giữ api_key/api_secret
//    an toàn (không thể gọi thẳng từ trình duyệt). Khi bạn đăng ký xong và
//    có backend, chỉ cần thay hàm fetchStockBars()/fetchStockQuote() bên
//    dưới để trỏ sang backend đó — phần giao diện/biểu đồ giữ nguyên.
//  - Nếu API công khai của TCBS chặn CORS hoặc đổi cấu trúc, khối
//    #stock-fetch-error sẽ hiển thị thông báo thay vì làm vỡ trang.
// =====================================================================

(function () {
  'use strict';

  // ---------- DANH SÁCH MÃ PHỔ BIẾN CHO CÁC CHIP NHANH ----------
  const STOCK_POPULAR = ['VNM', 'VIC', 'VCB', 'HPG', 'FPT'];

  // ---------- TRẠNG THÁI ----------
  let stockSymbol = (localStorage.getItem('ok_stock_symbol') || 'VNM').toUpperCase();
  let stockRes = localStorage.getItem('ok_stock_res') || 'D'; // D=Ngày, W=Tuần, M=Tháng
  let dailyBarsCache = []; // luôn lưu nến NGÀY gốc; W/M được gộp lại từ đây
  let stockChart = null, stockCandleSeries = null;
  let volumeChart = null, volumeSeries = null;
  let stockPollTimer = null;
  let stockInitDone = false;
  let currentMarketMode = localStorage.getItem('ok_market_mode') || 'crypto';
  let fetchToken = 0; // để hủy kết quả của request cũ khi đổi mã liên tục

  // ---------- MÀU SẮC (dùng chung theme với phần Crypto) ----------
  function upColor() { return localStorage.getItem('ok_upColor') || '#14cc8a'; }
  function downColor() { return localStorage.getItem('ok_downColor') || '#ff4757'; }

  // =====================================================================
  // TIỆN ÍCH
  // =====================================================================

  // Giờ Việt Nam hiện tại, dùng để biết thị trường đang mở hay đóng cửa,
  // không phụ thuộc múi giờ trình duyệt của người dùng.
  function getVnNow() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
      weekday: 'short', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const map = {};
    parts.forEach(p => map[p.type] = p.value);
    return { weekday: map.weekday, hour: parseInt(map.hour, 10), minute: parseInt(map.minute, 10) };
  }

  // Ước lượng thị trường cơ sở (HOSE/HNX/UPCOM) đang trong phiên khớp lệnh hay không.
  // (9:00-11:30 và 13:00-15:00, Thứ 2 - Thứ 6. Không tính lịch nghỉ lễ.)
  function isMarketOpen() {
    const { weekday, hour, minute } = getVnNow();
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    const mins = hour * 60 + minute;
    const morning = mins >= 9 * 60 && mins <= 11 * 60 + 30;
    const afternoon = mins >= 13 * 60 && mins <= 15 * 60;
    return morning || afternoon;
  }

  function fmtVnd(n) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    return n.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
  }

  function fmtVol(n) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  // Chuỗi "YYYY-MM-DDT..." -> {year, month, day} lấy trực tiếp từ chuỗi ngày,
  // KHÔNG đi qua Date object, để tránh lệch ngày do múi giờ trình duyệt.
  function isoToBizDay(iso) {
    const d = String(iso).slice(0, 10).split('-');
    return { year: parseInt(d[0], 10), month: parseInt(d[1], 10), day: parseInt(d[2], 10) };
  }
  function bizDayKey(b) { return b.year * 10000 + b.month * 100 + b.day; }

  function showStockError(msg) {
    const el = document.getElementById('stock-fetch-error');
    if (!el) return;
    if (!msg) { el.classList.remove('show'); el.textContent = ''; return; }
    el.textContent = msg;
    el.classList.add('show');
  }

  // =====================================================================
  // LẤY DỮ LIỆU NẾN NGÀY TỪ NGUỒN CÔNG KHAI (TCBS)
  // =====================================================================
  async function fetchDailyBars(symbol) {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 5 * 365 * 24 * 3600; // ~5 năm dữ liệu để gộp được cả khung Tuần/Tháng
    const url = `https://apipubaws.tcbs.com.vn/stock-insight/v1/stock/bars-long-term?ticker=${encodeURIComponent(symbol)}&type=stock&resolution=D&from=${from}&to=${to}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const rows = (json && (json.data || json.Data)) || [];
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('empty');

    const bars = rows.map(r => {
      const iso = r.tradingDate || r.TradingDate || r.date;
      return {
        biz: isoToBizDay(iso),
        open: Number(r.open ?? r.Open),
        high: Number(r.high ?? r.High),
        low: Number(r.low ?? r.Low),
        close: Number(r.close ?? r.Close),
        volume: Number(r.volume ?? r.Volume ?? 0),
      };
    }).filter(b => isFinite(b.open) && isFinite(b.close));

    // Sắp xếp theo thời gian tăng dần & loại trùng ngày (API có thể trả trùng lặp).
    bars.sort((a, b) => bizDayKey(a.biz) - bizDayKey(b.biz));
    const deduped = [];
    for (const b of bars) {
      if (deduped.length && bizDayKey(deduped[deduped.length - 1].biz) === bizDayKey(b.biz)) {
        deduped[deduped.length - 1] = b; // giữ bản ghi mới nhất trong ngày (giá cập nhật realtime trong phiên)
      } else {
        deduped.push(b);
      }
    }
    return deduped;
  }

  // Gộp nến Ngày thành nến Tuần hoặc Tháng ngay trên trình duyệt — không phụ
  // thuộc việc API nguồn có hỗ trợ khung thời gian đó hay không.
  function aggregateBars(daily, mode) {
    if (mode === 'D') return daily;
    const groups = new Map();
    for (const b of daily) {
      const d = new Date(Date.UTC(b.biz.year, b.biz.month - 1, b.biz.day));
      let key;
      if (mode === 'W') {
        const day = (d.getUTCDay() + 6) % 7; // 0 = Thứ 2
        const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - day);
        key = monday.toISOString().slice(0, 10);
      } else { // 'M'
        key = `${b.biz.year}-${String(b.biz.month).padStart(2, '0')}`;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    const out = [];
    for (const arr of groups.values()) {
      arr.sort((a, b) => bizDayKey(a.biz) - bizDayKey(b.biz));
      const last = arr[arr.length - 1];
      out.push({
        biz: last.biz, // hiển thị tại ngày giao dịch cuối cùng của tuần/tháng đó
        open: arr[0].open,
        high: Math.max(...arr.map(x => x.high)),
        low: Math.min(...arr.map(x => x.low)),
        close: last.close,
        volume: arr.reduce((s, x) => s + (x.volume || 0), 0),
      });
    }
    out.sort((a, b) => bizDayKey(a.biz) - bizDayKey(b.biz));
    return out;
  }

  // =====================================================================
  // BIỂU ĐỒ (lightweight-charts) — khởi tạo 1 lần, tái sử dụng cho mọi mã/khung
  // =====================================================================
  function ensureStockCharts() {
    if (stockChart) return;
    if (typeof LightweightCharts === 'undefined') return;

    const priceEl = document.getElementById('stock-chart');
    const volEl = document.getElementById('stock-volume-chart');
    if (!priceEl || !volEl) return;

    const commonOpts = {
      layout: { background: { color: 'transparent' }, textColor: '#7c8598' },
      grid: { vertLines: { color: '#212836' }, horzLines: { color: '#212836' } },
      timeScale: { borderColor: '#212836', timeVisible: false },
      rightPriceScale: { borderColor: '#212836' },
      crosshair: { mode: 0 },
    };

    stockChart = LightweightCharts.createChart(priceEl, Object.assign({
      width: priceEl.clientWidth, height: priceEl.clientHeight || 480,
    }, commonOpts));
    stockCandleSeries = stockChart.addCandlestickSeries({
      upColor: upColor(), downColor: downColor(),
      borderUpColor: upColor(), borderDownColor: downColor(),
      wickUpColor: upColor(), wickDownColor: downColor(),
    });

    volumeChart = LightweightCharts.createChart(volEl, Object.assign({
      width: volEl.clientWidth, height: volEl.clientHeight || 110,
    }, commonOpts, { timeScale: { visible: true, borderColor: '#212836' } }));
    volumeSeries = volumeChart.addHistogramSeries({ priceFormat: { type: 'volume' } });

    // Đồng bộ cuộn/zoom giữa 2 biểu đồ giá & khối lượng.
    stockChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (range) volumeChart.timeScale().setVisibleLogicalRange(range);
    });
    volumeChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (range) stockChart.timeScale().setVisibleLogicalRange(range);
    });

    const ro = new ResizeObserver(() => {
      if (stockChart) stockChart.resize(priceEl.clientWidth, priceEl.clientHeight || 480);
      if (volumeChart) volumeChart.resize(volEl.clientWidth, volEl.clientHeight || 110);
    });
    ro.observe(priceEl); ro.observe(volEl);
  }

  function renderBars(bars) {
    ensureStockCharts();
    if (!stockCandleSeries || !volumeSeries) return;

    const candleData = bars.map(b => ({ time: b.biz, open: b.open, high: b.high, low: b.low, close: b.close }));
    const volData = bars.map((b, i) => ({
      time: b.biz, value: b.volume,
      color: (i === 0 || b.close >= bars[i - 1].close) ? upColor() + '99' : downColor() + '99',
    }));
    stockCandleSeries.setData(candleData);
    volumeSeries.setData(volData);
    stockChart && stockChart.timeScale().fitContent();
    volumeChart && volumeChart.timeScale().fitContent();
  }

  // =====================================================================
  // CẬP NHẬT PHẦN GIÁ / THỐNG KÊ / TIÊU ĐỀ
  // =====================================================================
  function renderStats(bars) {
    const titleEl = document.getElementById('stock-chart-title');
    const priceEl = document.getElementById('stock-current-price');
    const changeEl = document.getElementById('stock-change-badge');
    const highEl = document.getElementById('stock-stat-high');
    const lowEl = document.getElementById('stock-stat-low');
    const refEl = document.getElementById('stock-stat-ref');
    const volEl = document.getElementById('stock-stat-vol');
    const updEl = document.getElementById('stock-stat-updated');
    const livePill = document.getElementById('stock-live-pill');
    const liveText = document.getElementById('stock-live-text');

    const resLabel = { D: 'Ngày', W: 'Tuần', M: 'Tháng' }[stockRes] || 'Ngày';
    if (titleEl) titleEl.innerHTML = `${stockSymbol} <span class="quote">${resLabel}</span>`;

    if (!bars || !bars.length) return;
    const last = bars[bars.length - 1];
    const prev = bars.length > 1 ? bars[bars.length - 2] : last;
    const change = last.close - prev.close;
    const changePct = prev.close ? (change / prev.close) * 100 : 0;
    const isUp = change >= 0;

    if (priceEl) {
      priceEl.textContent = fmtVnd(last.close);
      priceEl.className = 'price-main num ' + (isUp ? 'up' : 'down');
    }
    if (changeEl) {
      changeEl.textContent = `${isUp ? '+' : ''}${fmtVnd(change)} (${isUp ? '+' : ''}${changePct.toFixed(2)}%)`;
      changeEl.className = 'change-badge num ' + (isUp ? 'up' : 'down');
    }
    if (highEl) highEl.textContent = fmtVnd(last.high);
    if (lowEl) lowEl.textContent = fmtVnd(last.low);
    if (refEl) refEl.textContent = fmtVnd(prev.close);
    if (volEl) volEl.textContent = fmtVol(last.volume);
    if (updEl) updEl.textContent = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const open = isMarketOpen();
    if (livePill) livePill.classList.toggle('closed', !open);
    if (liveText) liveText.textContent = open ? 'ĐANG GIAO DỊCH' : 'ĐÃ ĐÓNG CỬA';
  }

  // =====================================================================
  // LUỒNG CHÍNH: tải dữ liệu cho 1 mã + khung thời gian, rồi vẽ lên
  // =====================================================================
  async function loadStock(symbol, res, opts) {
    opts = opts || {};
    const myToken = ++fetchToken;
    showStockError('');
    if (!opts.silent) {
      const liveText = document.getElementById('stock-live-text');
      if (liveText) liveText.textContent = 'ĐANG TẢI';
    }
    try {
      // Chỉ gọi lại API nếu đổi mã, hoặc chưa có cache, hoặc là lần tải mới (không phải poll).
      if (opts.forceFetch || symbol !== stockSymbol || dailyBarsCache.length === 0) {
        dailyBarsCache = await fetchDailyBars(symbol);
      }
      if (myToken !== fetchToken) return; // đã có yêu cầu mới hơn, bỏ kết quả cũ

      stockSymbol = symbol;
      stockRes = res;
      localStorage.setItem('ok_stock_symbol', stockSymbol);
      localStorage.setItem('ok_stock_res', stockRes);

      const bars = aggregateBars(dailyBarsCache, stockRes);
      renderBars(bars);
      renderStats(bars);
    } catch (err) {
      if (myToken !== fetchToken) return;
      console.log('Lỗi tải dữ liệu chứng khoán VN:', err);
      showStockError('Không tải được dữ liệu cho mã "' + symbol + '". Nguồn dữ liệu công khai có thể tạm thời không phản hồi, chặn truy cập trực tiếp từ trình duyệt (CORS), hoặc mã không tồn tại. Vui lòng thử lại hoặc kiểm tra mã chứng khoán.');
      const liveText = document.getElementById('stock-live-text');
      if (liveText) liveText.textContent = 'LỖI TẢI DỮ LIỆU';
    }
  }

  function startStockPolling() {
    stopStockPolling();
    stockPollTimer = setInterval(() => {
      if (currentMarketMode !== 'stock') return;
      if (!isMarketOpen()) return; // đóng cửa thì không cần gọi API liên tục
      loadStock(stockSymbol, stockRes, { silent: true, forceFetch: true });
    }, 20000); // 20 giây/lần trong giờ giao dịch
  }
  function stopStockPolling() {
    if (stockPollTimer) { clearInterval(stockPollTimer); stockPollTimer = null; }
  }

  // =====================================================================
  // GẮN SỰ KIỆN GIAO DIỆN
  // =====================================================================
  function setActiveChip(symbol) {
    document.querySelectorAll('#stock-chip-container .chip').forEach(c => {
      c.classList.toggle('active', c.getAttribute('data-symbol') === symbol);
    });
  }

  function validateSymbol(raw) {
    const s = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.length < 2 || s.length > 6) return null;
    return s;
  }

  function wireStockUI() {
    // Chip mã nhanh
    document.querySelectorAll('#stock-chip-container .chip').forEach(chip => {
      chip.addEventListener('click', function () {
        const sym = this.getAttribute('data-symbol');
        setActiveChip(sym);
        document.getElementById('stock-symbol-input').value = sym;
        showStockError('');
        loadStock(sym, stockRes, { forceFetch: true });
      });
    });

    // Ô tìm kiếm mã
    const input = document.getElementById('stock-symbol-input');
    const searchBtn = document.getElementById('stock-search-btn');
    function doSearch() {
      const sym = validateSymbol(input.value);
      const errEl = document.getElementById('stock-symbol-error');
      if (!sym) {
        if (errEl) { errEl.textContent = 'Mã chứng khoán không hợp lệ.'; errEl.classList.add('show'); }
        return;
      }
      if (errEl) errEl.classList.remove('show');
      input.value = sym;
      setActiveChip(sym);
      loadStock(sym, stockRes, { forceFetch: true });
    }
    if (searchBtn) searchBtn.addEventListener('click', doSearch);
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

    // Tab khung thời gian Ngày/Tuần/Tháng
    document.querySelectorAll('#stock-tf-container .tf-btn').forEach(btn => {
      btn.addEventListener('click', function () {
        document.querySelectorAll('#stock-tf-container .tf-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        const res = this.getAttribute('data-res');
        stockRes = res;
        localStorage.setItem('ok_stock_res', res);
        const bars = aggregateBars(dailyBarsCache, res);
        renderBars(bars);
        renderStats(bars);
      });
    });
  }

  // =====================================================================
  // CHUYỂN ĐỔI CHẾ ĐỘ CRYPTO <-> CHỨNG KHOÁN VN
  // =====================================================================
  function applyMarketMode(mode) {
    currentMarketMode = mode;
    localStorage.setItem('ok_market_mode', mode);

    const cryptoView = document.getElementById('crypto-view');
    const stockView = document.getElementById('stock-view');
    const btnCrypto = document.getElementById('btn-mk-crypto');
    const btnStock = document.getElementById('btn-mk-stock');

    const isStock = mode === 'stock';
    if (cryptoView) cryptoView.style.display = isStock ? 'none' : '';
    if (stockView) stockView.style.display = isStock ? '' : 'none';
    if (btnCrypto) btnCrypto.classList.toggle('active', !isStock);
    if (btnStock) btnStock.classList.toggle('active', isStock);

    if (isStock) {
      if (!stockInitDone) {
        stockInitDone = true;
        setActiveChip(STOCK_POPULAR.includes(stockSymbol) ? stockSymbol : null);
        document.getElementById('stock-symbol-input').value = stockSymbol;
        document.querySelectorAll('#stock-tf-container .tf-btn').forEach(b => {
          b.classList.toggle('active', b.getAttribute('data-res') === stockRes);
        });
        loadStock(stockSymbol, stockRes, { forceFetch: true });
      } else {
        // Quay lại chế độ chứng khoán: biểu đồ có thể bị co kích thước lúc ẩn, resize lại + đồng bộ.
        setTimeout(() => {
          if (stockChart) stockChart.resize(document.getElementById('stock-chart').clientWidth, 480);
          if (volumeChart) volumeChart.resize(document.getElementById('stock-volume-chart').clientWidth, 110);
        }, 0);
      }
      startStockPolling();
    } else {
      stopStockPolling();
    }
  }

  function wireMarketSwitch() {
    const btnCrypto = document.getElementById('btn-mk-crypto');
    const btnStock = document.getElementById('btn-mk-stock');
    if (btnCrypto) btnCrypto.addEventListener('click', () => applyMarketMode('crypto'));
    if (btnStock) btnStock.addEventListener('click', () => applyMarketMode('stock'));
  }

  // =====================================================================
  // KHỞI TẠO
  // =====================================================================
  function init() {
    wireStockUI();
    wireMarketSwitch();
    // Luôn khởi động ở chế độ Crypto khi tải trang (dù lần trước người dùng
    // đang ở chế độ chứng khoán) để không cản trở việc engine crypto trong
    // script.js khởi động bình thường; người dùng bấm nút để chuyển sang.
    applyMarketMode('crypto');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
