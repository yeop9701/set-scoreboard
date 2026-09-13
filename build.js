#!/usr/bin/env node
/**
 * workout.html(아티팩트 소스) → 정적 웹 배포본
 *
 * 아티팩트로 발행할 때는 claude.ai 뷰어가 <!doctype>·<head>·<body> 껍데기를
 * 붙여 주므로 workout.html에는 그것들이 없다. 일반 웹 호스팅(GitHub Pages)에
 * 그대로 올리면 quirks 모드로 렌더링되고, 무엇보다 viewport 메타가 없어서
 * 휴대폰에서 데스크톱 폭으로 축소돼 보인다. 이 스크립트가 그 껍데기와
 * PWA 설정(매니페스트·아이콘·서비스워커)을 붙여 index.html을 만든다.
 *
 *   node build.js
 *
 * 생성물: index.html, manifest.webmanifest, sw.js, icons/*.png
 * workout.html을 고친 뒤에는 반드시 다시 실행해야 배포본에 반영된다.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const ROOT = __dirname;
const SRC = path.join(ROOT, "workout.html");

const NAME = "세트 스코어보드";
const SHORT = "스코어보드";
const DESC = "세트마다 체크하는 운동 기록. 남은 세트, 연속 완주, 월별 밀도를 한 화면에서 봅니다.";

/* ── 아이콘: 앱의 핍(●●●○) 모티프를 2×2로 그린다 ───────────── */
const ICON_BG = [0x10, 0x18, 0x20];   // 전광판 하우징
const ICON_ON = [0xFF, 0x94, 0x26];   // LED 앰버 — 완료한 세트
const ICON_OFF = [0x3A, 0x47, 0x53];  // 남은 세트 테두리

let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_T[n] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 의존성 없이 RGB PNG를 직접 인코딩한다 (zlib은 Node 내장) */
function icon(size) {
  // 마스커블 안전영역(중심 반경 0.4) 안에 들어오도록 배치
  const cs = [0.33 * size, 0.67 * size];
  const r = 0.14 * size;
  const ringW = 0.048 * size;
  const pips = [
    [cs[0], cs[0], true], [cs[1], cs[0], true],
    [cs[0], cs[1], true], [cs[1], cs[1], false],
  ];
  const SS = 3;                       // 3×3 슈퍼샘플링으로 경계를 매끈하게
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;              // 필터 타입 0 (None)
    for (let x = 0; x < size; x++) {
      let sr = 0, sg = 0, sb = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          let col = ICON_BG;
          for (const [cx, cy, filled] of pips) {
            const d = Math.hypot(px - cx, py - cy);
            if (filled) { if (d <= r) { col = ICON_ON; break; } }
            else if (d <= r && d >= r - ringW) { col = ICON_OFF; break; }
          }
          sr += col[0]; sg += col[1]; sb += col[2];
        }
      }
      const n = SS * SS;
      const o = y * stride + 1 + x * 3;
      raw[o] = Math.round(sr / n);
      raw[o + 1] = Math.round(sg / n);
      raw[o + 2] = Math.round(sb / n);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type: truecolor RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ── 빌드 ──────────────────────────────────────────────────── */
const src = fs.readFileSync(SRC, "utf8");
const stamp = crypto.createHash("sha256").update(src).digest("hex").slice(0, 10);

// workout.html은 <title>·<link>·<style>가 앞쪽에, 마크업과 <script>가 뒤에 온다.
const cutAt = src.indexOf("</style>");
if (cutAt < 0) {
  console.error("workout.html에서 </style>를 찾지 못했습니다. 구조가 바뀌었는지 확인하세요.");
  process.exit(1);
}
const cut = cutAt + "</style>".length;
const headPart = src.slice(0, cut).trim();
const bodyPart = src.slice(cut).trim();

// viewport-fit=cover 가 있어야 env(safe-area-inset-*)가 실제 값을 갖는다
const index = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${DESC}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141C23" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${SHORT}">
<meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" type="image/png" sizes="192x192" href="./icons/icon-192.png">
<link rel="icon" type="image/png" sizes="512x512" href="./icons/icon-512.png">
<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png">
<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0}</style>
${headPart}
</head>
<body>
${bodyPart}
<script>
/* 체육관 신호가 약해도 열리도록 셸을 캐시한다 */
if ("serviceWorker" in navigator && location.protocol === "https:") {
  addEventListener("load", function () {
    navigator.serviceWorker.register("./sw.js").catch(function () {});
  });
}
</script>
</body>
</html>
`;

const manifest = {
  name: NAME,
  short_name: SHORT,
  description: DESC,
  lang: "ko",
  start_url: "./",
  scope: "./",
  display: "standalone",
  orientation: "portrait",
  background_color: "#EDEFF2",
  theme_color: "#C85B08",
  icons: [
    { src: "./icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "./icons/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "./icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

const sw = `/* 자동 생성 — build.js가 workout.html 해시로 버전을 찍는다 */
"use strict";
const CACHE = "scoreboard-${stamp}";
const SHELL = [
  "./", "./index.html", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .catch(function () {})
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  // 페이지 본문은 네트워크 우선 — 새 배포가 바로 반영되게
  var isPage = req.mode === "navigate" ||
    (req.headers.get("accept") || "").indexOf("text/html") !== -1;

  if (isPage) {
    e.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            return hit || caches.match("./index.html");
          });
        })
    );
    return;
  }

  // 그 외(아이콘·폰트)는 캐시 우선
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && (res.ok || res.type === "opaque")) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      });
    })
  );
});
`;

fs.writeFileSync(path.join(ROOT, "index.html"), index, "utf8");
fs.writeFileSync(path.join(ROOT, "manifest.webmanifest"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
fs.writeFileSync(path.join(ROOT, "sw.js"), sw, "utf8");
// Pages는 Jekyll로 처리하며 밑줄로 시작하는 경로를 무시한다 — 그냥 끈다
fs.writeFileSync(path.join(ROOT, ".nojekyll"), "", "utf8");

const iconDir = path.join(ROOT, "icons");
fs.mkdirSync(iconDir, { recursive: true });
const icons = [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]];
for (const [file, size] of icons) {
  fs.writeFileSync(path.join(iconDir, file), icon(size));
}

const kb = n => (n / 1024).toFixed(1) + " KB";
console.log("빌드 완료  (소스 해시 " + stamp + ")");
console.log("  index.html            " + kb(Buffer.byteLength(index)));
console.log("  manifest.webmanifest  " + kb(Buffer.byteLength(JSON.stringify(manifest))));
console.log("  sw.js                 " + kb(Buffer.byteLength(sw)));
for (const [file] of icons) {
  console.log("  icons/" + file.padEnd(16) + kb(fs.statSync(path.join(iconDir, file)).size));
}
