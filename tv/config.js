// The stream /tv plays. Edit these two lines, commit, redeploy.
// The URL must be https:// — kn0ble.com is served over HTTPS, and
// browsers block http:// video on an https page (mixed content).
// The stream's server must also allow cross-origin requests (CORS);
// if it doesn't, the page says so and the stream needs proxying.
window.TV_CONFIG = {
  name: "Live",
  url: "https://example.com/path/to/stream.m3u8"
};
