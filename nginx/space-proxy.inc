# Shared settings for the /space/api/ upstream proxies (included from
# default.conf). Lives in conf.d with a .inc name so nginx's
# conf.d/*.conf include does not load it on its own.
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Accept-Encoding "";
proxy_set_header User-Agent "kn0ble.com satellite pass page (KN0BLE; +https://kn0ble.com/space/)";
proxy_set_header Cookie "";
resolver_timeout 5s;
proxy_ssl_server_name on;
proxy_ssl_verify on;
proxy_ssl_verify_depth 3;
proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
proxy_connect_timeout 10s;
proxy_hide_header Set-Cookie;
proxy_ignore_headers Cache-Control Expires Set-Cookie Vary;
proxy_cache space;
proxy_cache_key $uri$is_args$args;
proxy_cache_lock on;
proxy_cache_lock_timeout 30s;
proxy_cache_use_stale error timeout updating http_403 http_429 http_500 http_502 http_503 http_504;
proxy_cache_background_update on;
proxy_intercept_errors off;
expires -1;
