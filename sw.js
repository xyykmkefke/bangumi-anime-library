// 应用壳离线缓存：页面网络优先并带超时回退，其余同源资源缓存优先、后台更新
// 壳缓存随版本升级整体替换；封面单独放一个长期缓存，发版不再清空已下载的图片
var CACHE = 'yuc-anime-shell-v31';
var IMG_CACHE = 'yuc-anime-images-v1';
var SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './data/anime-lite.js'];
var IMG_LIMIT = 500;

// activate 时保留的缓存：其余 yuc-anime- 前缀的一律删除
var KEEP = [CACHE, IMG_CACHE];

// 封面缓存有上限：超出后按插入顺序清理最旧的，避免长期使用占满配额
function trimImageCache(cache) {
  return cache.keys().then(function (keys) {
    if (keys.length <= IMG_LIMIT) return null;
    var drop = keys.slice(0, keys.length - IMG_LIMIT);
    return Promise.all(drop.map(function (req) { return cache.delete(req); }));
  }).catch(function () {});
}

// 全库数据去重：两个 CDN 都下载过时，缓存里会留两份 anime-data.js（约 5MB）。
// 应用永远优先用 PRIMARY_DATA_HOST 那份，所以只要它在，其余同文件副本都是纯占地方。
// 只删"另一主机"的副本、且仅当主源存在——若用户网络只能通备用源，那份是唯一的离线副本，必须留着。
var PRIMARY_DATA_HOST = 'cdn.jsdelivr.net';
function dropDuplicateData(cache) {
  return cache.keys().then(function (keys) {
    var dataKeys = keys.filter(function (req) { return req.url.indexOf('anime-data.js') >= 0; });
    if (dataKeys.length < 2) return null;
    var hostOf = function (req) { return new URL(req.url).hostname; };
    var hasPrimary = dataKeys.some(function (req) { return hostOf(req) === PRIMARY_DATA_HOST; });
    if (!hasPrimary) return null;
    return Promise.all(dataKeys.filter(function (req) {
      return hostOf(req) !== PRIMARY_DATA_HOST;
    }).map(function (req) { return cache.delete(req); }));
  }).catch(function () {});
}

// 缓存写入是后台动作：挂钩 waitUntil 防止响应返回后 SW 被回收导致写入丢失
function keepAlive(e, promise) {
  try { e.waitUntil(promise); } catch (err) { /* 事件已结束则退化为尽力而为 */ }
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // 逐项写入并容错：addAll 是全有或全无，任一文件 404 会让整次更新失败、旧 SW 长期驻留
      return Promise.all(SHELL.map(function (url) {
        // 强制走网络，避免 HTTP 缓存让新版本壳继续用旧文件
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () {
          console.warn('[sw] 预缓存失败，已跳过：' + url);
        });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      // 同源还部署着轻小说、galgame 等项目，只清理本项目前缀的旧缓存
      return Promise.all(keys.map(function (key) {
        if (KEEP.indexOf(key) >= 0) return null;
        if (key.indexOf('yuc-anime-') !== 0) return null;
        return caches.delete(key);
      }));
    }).then(function () {
      // 清掉历史遗留的双份全库数据（一次约 2.5MB），只保留应用实际使用的那份
      return caches.open(CACHE).then(dropDuplicateData).catch(function () {});
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  // 封面等图片：缓存优先，命中直接返回，未命中走网络并写入专用的图片缓存
  if (req.destination === 'image') {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          // 封面多为跨域 opaque 响应（status 0），同样可以缓存供离线使用
          if (res.ok || res.type === 'opaque') {
            var copy = res.clone();
            keepAlive(e, caches.open(IMG_CACHE).then(function (cache) {
              return cache.put(req, copy).then(function () { return trimImageCache(cache); });
            }));
          }
          return res;
        });
      })
    );
    return;
  }

  var url = new URL(req.url);

  // 全库数据走 jsDelivr：标签 URL 不可变，命中即用；首次未命中才下载并缓存
  if (url.hostname.indexOf('jsdelivr.net') >= 0) {
    var immutable = /@v\d/.test(url.pathname);
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit && immutable) return hit;
        var net = fetch(req).then(function (res) {
          // 只缓存成功响应；脚本标签已启用 CORS，404/5xx 能如实拿到 ok=false，不再被当成好东西存下来
          if (res.ok || res.type === 'opaque') {
            var copy = res.clone();
            keepAlive(e, caches.open(CACHE).then(function (cache) { return cache.put(req, copy); }));
          } else if (hit) {
            return hit;
          }
          return res;
        }).catch(function () {
          return hit;
        });
        return hit || net;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // 手动"检查更新"的探测请求不拦截：它带唯一时间戳且要求 no-store，进缓存只会白占空间
  if (url.searchParams.has('check')) return;

  // 页面本身：网络优先；1.5s 内没回来就先展示缓存，等下次启动再用新版
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res.ok) {
            var copy = res.clone();
            // 以 pathname 规范化键写入，避免 ?utm/?from= 之类的查询串各存一份
            var key = new Request(url.origin + url.pathname);
            keepAlive(e, caches.open(CACHE).then(function (cache) { return cache.put(key, copy); }));
            return res;
          }
          // 部署中/回滚时的 502/404 不应盖掉可用的离线壳
          return hit || res;
        }).catch(function () {
          return hit || caches.match('./', { ignoreSearch: true });
        });
        if (!hit) return net;
        var timer = new Promise(function (resolve) {
          setTimeout(function () { resolve(hit); }, 1500);
        });
        return Promise.race([net, timer]);
      })
    );
    return;
  }

  // 数据与静态资源：立即用缓存，后台拉新版本供下次使用
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          keepAlive(e, caches.open(CACHE).then(function (cache) { return cache.put(req, copy); }));
          return res;
        }
        return hit || res;
      }).catch(function () {
        return hit;
      });
      return hit || net;
    })
  );
});
