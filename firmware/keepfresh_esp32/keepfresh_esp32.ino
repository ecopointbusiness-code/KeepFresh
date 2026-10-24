/*
  KeepFresh Indicator Unit - ESP32 firmware
  Hardware: ESP32 dev board, 3.5" SPI TFT (ILI9488), traffic-light LED module, active buzzer.

  Libraries (Arduino Library Manager): TFT_eSPI, ArduinoJson (v7)
  TFT_eSPI: choose the driver and pins in its User_Setup.h (see docs/wiring-guide.html).

  Wiring:
    Traffic light module  G -> GPIO 25, Y -> GPIO 26, R -> GPIO 27, GND -> GND
    Active buzzer         S/+ -> GPIO 33, GND -> GND
    TFT (ILI9488)         MOSI 23, SCLK 18, CS 15, DC 2, RST 4, MISO 19 (optional), VCC/LED 3V3, GND
    BOOT button (already on the board, GPIO 0): press once to silence the buzzer for 1 hour, press again to un-mute.

  The screen shows: status banner, counts (fresh / use soon / use today / expired), the items that need
  attention with their exact days left, a cooking tip, admin advisories, Wi-Fi strength, clock, and
  the device code when the unit is not linked to a household yet.
*/
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <TFT_eSPI.h>
#include <time.h>

// ---- EDIT THESE ----
const char* WIFI_SSID  = "YOUR_WIFI";
const char* WIFI_PASS  = "YOUR_PASSWORD";
const char* SERVER     = "https://your-keepfresh-domain.com";   // no trailing slash. http://192.168.x.x:3000 also works
const char* DEVICE_KEY = "PASTE_API_KEY_FROM_ADMIN_PORTAL";
const long  GMT_OFFSET = 8 * 3600;                              // Philippines (UTC+8)
const unsigned long POLL_MS = 30000;
// --------------------

const int PIN_G = 25, PIN_Y = 26, PIN_R = 27, PIN_BUZ = 33, PIN_MUTE = 0;
const unsigned long MUTE_MS = 3600000UL, REPEAT_ALARM_MS = 1800000UL;

#define C565(r, g, b) ((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3))
const uint16_t BG = C565(22, 30, 3), PANEL = C565(40, 54, 8), CREAM = C565(248, 244, 240), OLIVE = C565(148, 168, 78), DKGRN = C565(49, 68, 1),
               BROWN = C565(166, 108, 65), RED = C565(199, 26, 23), ORANGE = C565(238, 113, 33), GOLD = C565(212, 167, 53), GREEN = C565(95, 130, 28), MUTED = C565(165, 170, 135);

TFT_eSPI tft = TFT_eSPI();

// ---- data from the server ----
struct Row { String name, level, qty; int days; };
Row rows[6]; int nRows = 0;
int cFresh = 0, cWatch = 0, cWarn = 0, cCrit = 0, nAttention = 0, nTotal = 0;
String led = "green", household = "", tip = "", advisory = "", devCode = "", lastSig = "";
bool linked = true, serverOk = false, haveData = false, buzzerFlag = false;

unsigned long lastPoll = 0, lastOkMs = 0, lastAlarmMs = 0, muteUntil = 0, lastFooterMs = 0, lastHeaderMs = 0;
bool muted = false;
String lastFooter = "";

// ---------- outputs ----------
void leds(bool g, bool y, bool r) { digitalWrite(PIN_G, g); digitalWrite(PIN_Y, y); digitalWrite(PIN_R, r); }
void beep(int times, int ms = 150) { for (int i = 0; i < times; i++) { digitalWrite(PIN_BUZ, HIGH); delay(ms); digitalWrite(PIN_BUZ, LOW); delay(ms); } }
void soundAlarm(int times, int ms) { if (!muted) beep(times, ms); }

// ---------- drawing helpers ----------
void text(int x, int y, int size, uint16_t color, const String& s, uint16_t bg = BG) { tft.setTextSize(size); tft.setTextColor(color, bg); tft.setCursor(x, y); tft.print(s); }
void textRight(int xRight, int y, int size, uint16_t color, const String& s, uint16_t bg = BG) { tft.setTextSize(size); int w = tft.textWidth(s); text(xRight - w, y, size, color, s, bg); }
void textCenter(int cx, int y, int size, uint16_t color, const String& s, uint16_t bg = BG) { tft.setTextSize(size); int w = tft.textWidth(s); text(cx - w / 2, y, size, color, s, bg); }
String clip(String s, int maxChars) { if ((int)s.length() <= maxChars) return s; return s.substring(0, maxChars - 1) + "."; }
uint16_t levelColor(const String& l) { return l == "Critical" ? RED : l == "Warning" ? ORANGE : GOLD; }

String daysText(int d) { if (d < 0) return "EXPIRED " + String(-d) + "d"; if (d == 0) return "TODAY"; if (d == 1) return "TOMORROW"; return String(d) + " DAYS"; }

void drawWifi(int xRight, int y) {
  int bars = 0;
  if (WiFi.status() == WL_CONNECTED) { int r = WiFi.RSSI(); bars = r > -55 ? 4 : r > -65 ? 3 : r > -75 ? 2 : 1; }
  for (int i = 0; i < 4; i++) { int h = 5 + i * 4, x = xRight - 28 + i * 7; tft.fillRect(x, y + 17 - h, 5, h, i < bars ? CREAM : DKGRN + 0x2104); }
}

void drawHeader() {
  tft.fillRect(0, 0, tft.width(), 32, DKGRN);
  text(10, 8, 2, CREAM, "KEEP", DKGRN); text(10 + 54, 8, 2, OLIVE, "FRESH", DKGRN);
  tft.fillRect(0, 32, tft.width(), 2, BROWN);
  if (household.length()) textCenter(tft.width() / 2 + 20, 11, 1, MUTED, clip(household, 22), DKGRN);
  struct tm t; String clk = "";
  if (getLocalTime(&t, 5)) { int h = t.tm_hour % 12; if (h == 0) h = 12; char b[12]; snprintf(b, sizeof b, "%d:%02d %s", h, t.tm_min, t.tm_hour < 12 ? "AM" : "PM"); clk = b; }
  drawWifi(tft.width() - 10, 8);
  if (clk.length()) textRight(tft.width() - 48, 8, 2, CREAM, clk, DKGRN);
  if (muted) { tft.fillRoundRect(150, 6, 44, 18, 4, ORANGE); text(155, 10, 1, BG, "MUTED", ORANGE); }
  lastHeaderMs = millis();
}

void drawBanner() {
  uint16_t col = led == "red" ? RED : led == "yellow" ? GOLD : GREEN, fg = led == "yellow" ? BG : CREAM;
  String big = led == "red" ? (cCrit > 0 ? "DISCARD NOW" : "USE TODAY") : led == "yellow" ? "USE SOON" : "ALL FRESH";
  String sub = led == "green" ? (nTotal ? String(nTotal) + " items in your fridge" : "Fridge is empty") : String(nAttention) + (nAttention == 1 ? " item needs attention" : " items need attention");
  tft.fillRoundRect(8, 40, tft.width() - 16, 50, 10, col);
  text(18, 46, 3, fg, big, col); textRight(tft.width() - 18, 52, 1, fg, sub, col);
  textRight(tft.width() - 18, 68, 1, fg, led == "red" ? "Check the list below" : led == "yellow" ? "Cook these first" : "Keep it up!", col);
}

void chip(int x, int w, uint16_t col, int n, const char* label) {
  tft.fillRoundRect(x, 96, w, 36, 8, PANEL); tft.fillRect(x, 96 + 6, 4, 24, col);
  text(x + 12, 100, 3, n ? col : MUTED, String(n), PANEL); text(x + 12, 124, 1, MUTED, label, PANEL);
}
void drawCounts() {
  int w = (tft.width() - 16 - 3 * 6) / 4, x = 8;
  chip(x, w, GREEN, cFresh, "FRESH"); x += w + 6; chip(x, w, GOLD, cWatch, "USE SOON"); x += w + 6; chip(x, w, ORANGE, cWarn, "USE TODAY"); x += w + 6; chip(x, w, RED, cCrit, "EXPIRED");
}

void drawItems() {
  tft.fillRect(0, 138, tft.width(), 128, BG);
  if (nRows == 0) { textCenter(tft.width() / 2, 172, 2, OLIVE, "Nothing is about to expire", BG); textCenter(tft.width() / 2, 200, 1, MUTED, "Great job keeping your food fresh!", BG); return; }
  int show = nRows > 4 ? 4 : nRows;
  for (int i = 0; i < show; i++) {
    int y = 138 + i * 32; uint16_t col = levelColor(rows[i].level);
    tft.fillRoundRect(8, y, tft.width() - 16, 28, 6, PANEL); tft.fillRoundRect(8, y, 8, 28, 3, col);
    text(24, y + 6, 2, CREAM, clip(rows[i].name, 16), PANEL);
    if (rows[i].qty.length() && rows[i].qty != "1") text(24 + 12 * 16 + 8, y + 11, 1, MUTED, "x" + clip(rows[i].qty, 6), PANEL);
    textRight(tft.width() - 18, y + 6, 2, col, daysText(rows[i].days), PANEL);
  }
  if (nAttention > show) textRight(tft.width() - 12, 266 - 10, 1, MUTED, "+" + String(nAttention - show) + " more in the app", BG);
}

String footerText(uint16_t& bgc, uint16_t& fg) {
  String pages[4]; uint16_t pb[4], pf[4]; int n = 0;
  if (!serverOk && haveData) { pages[n] = "Server offline - showing last data"; pb[n] = RED; pf[n] = CREAM; n++; }
  if (advisory.length()) { pages[n] = "ADVISORY: " + advisory; pb[n] = ORANGE; pf[n] = BG; n++; }
  if (tip.length()) { pages[n] = "Cook: " + tip; pb[n] = PANEL; pf[n] = OLIVE; n++; }
  unsigned long ago = (millis() - lastOkMs) / 1000; String upd = lastOkMs ? (ago < 90 ? String(ago) + "s ago" : String(ago / 60) + "m ago") : "never";
  pages[n] = String(nTotal) + " items | updated " + upd + (muted ? " | muted" : ""); pb[n] = PANEL; pf[n] = MUTED; n++;
  int idx = (millis() / 5000) % n; bgc = pb[idx]; fg = pf[idx]; return pages[idx];
}
void drawFooter(bool force = false) {
  uint16_t bgc, fg; String s = footerText(bgc, fg);
  if (!force && s == lastFooter) return;
  lastFooter = s; lastFooterMs = millis();
  tft.fillRoundRect(8, 276, tft.width() - 16, 36, 8, bgc);
  if (s.length() > 38) { text(16, 281, 1, fg, clip(s, 76).substring(0, 76), bgc); if (s.length() > 76) text(16, 296, 1, fg, s.substring(76, 152), bgc); }
  else text(16, 286, 2, fg, s, bgc);
}

void drawDashboard() { tft.fillScreen(BG); drawHeader(); drawBanner(); drawCounts(); drawItems(); drawFooter(true); }

void drawUnlinked() {
  tft.fillScreen(BG); drawHeader();
  textCenter(tft.width() / 2, 60, 2, CREAM, "This unit is not linked yet", BG);
  tft.fillRoundRect(60, 100, tft.width() - 120, 70, 12, PANEL);
  textCenter(tft.width() / 2, 108, 1, MUTED, "DEVICE CODE", PANEL); textCenter(tft.width() / 2, 128, 4, GOLD, devCode, PANEL);
  textCenter(tft.width() / 2, 196, 2, OLIVE, "In the KeepFresh app open", BG);
  textCenter(tft.width() / 2, 220, 2, OLIVE, "Profile > Indicator Unit", BG);
  textCenter(tft.width() / 2, 244, 2, OLIVE, "and enter this code", BG);
}

void splash(const String& line) {
  tft.fillScreen(BG);
  textCenter(tft.width() / 2, 100, 4, CREAM, "KEEP", BG); textCenter(tft.width() / 2, 140, 4, OLIVE, "FRESH", BG);
  textCenter(tft.width() / 2, 190, 1, BROWN, "KEEPING FRESHNESS ALIVE", BG);
  textCenter(tft.width() / 2, 230, 2, MUTED, line, BG);
}

// ---------- network ----------
void connectWifi() {
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS);
  splash("Connecting to Wi-Fi...");
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(500);
  if (WiFi.status() == WL_CONNECTED) configTime(GMT_OFFSET, 0, "pool.ntp.org", "time.google.com");
  else splash("Wi-Fi failed. Retrying...");
}

void applyStatus(JsonDocument& doc) {
  led = doc["led"].as<String>(); buzzerFlag = doc["buzzer"] | false; nAttention = doc["count"] | 0; nTotal = doc["total"] | 0;
  household = doc["household"] | ""; tip = doc["tip"] | ""; advisory = doc["advisory"] | ""; devCode = doc["code"] | ""; linked = doc["linked"] | true;
  cFresh = doc["counts"]["fresh"] | 0; cWatch = doc["counts"]["watch"] | 0; cWarn = doc["counts"]["warning"] | 0; cCrit = doc["counts"]["critical"] | 0;
  nRows = 0;
  for (JsonObject it : doc["items"].as<JsonArray>()) {
    if (nRows >= 6) break;
    rows[nRows].name = it["name"].as<String>(); rows[nRows].level = it["level"].as<String>(); rows[nRows].qty = it["qty"].as<String>(); rows[nRows].days = it["days"] | 0; nRows++;
  }
}

void poll() {
  if (WiFi.status() != WL_CONNECTED) { serverOk = false; connectWifi(); if (haveData) drawDashboard(); return; }
  WiFiClientSecure secure; WiFiClient plain; HTTPClient http;
  secure.setInsecure();   // for production, pin your server certificate with secure.setCACert(...)
  String url = String(SERVER) + "/api/device/status";
  bool began = url.startsWith("https://") ? http.begin(secure, url) : http.begin(plain, url);
  if (!began) { serverOk = false; return; }
  http.setTimeout(8000); http.addHeader("x-device-key", DEVICE_KEY);
  int code = http.GET();
  if (code != 200) { http.end(); bool was = serverOk; serverOk = false; if (was || !haveData) { if (haveData) drawFooter(true); else splash("Server error " + String(code)); } return; }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, http.getString());
  http.end();
  if (err) { serverOk = false; return; }

  bool cameBack = !serverOk; serverOk = true; haveData = true; lastOkMs = millis();
  String cmd = doc["command"].isNull() ? "" : doc["command"].as<String>();
  if (cmd == "restart") ESP.restart();
  if (cmd == "test") { leds(1, 0, 0); delay(400); leds(0, 1, 0); delay(400); leds(0, 0, 1); delay(400); }
  if (cmd == "buzz") beep(3);

  applyStatus(doc);
  leds(led == "green", led == "yellow", led == "red");
  String sig; serializeJson(doc, sig);
  if (sig != lastSig || cameBack) {
    bool newDanger = (sig != lastSig);
    lastSig = sig;
    if (!linked) drawUnlinked(); else drawDashboard();
    if (buzzerFlag && newDanger) { soundAlarm(2, 200); lastAlarmMs = millis(); }
  }
  if (buzzerFlag && millis() - lastAlarmMs > REPEAT_ALARM_MS) { soundAlarm(2, 200); lastAlarmMs = millis(); }   // gentle reminder every 30 minutes
}

// BOOT button: mute the buzzer for one hour, press again to un-mute
void checkButton() {
  static bool was = false; static unsigned long t = 0;
  bool down = digitalRead(PIN_MUTE) == LOW;
  if (down && !was && millis() - t > 300) {
    t = millis(); muted = !muted; muteUntil = muted ? millis() + MUTE_MS : 0;
    if (!muted) beep(1, 80); drawHeader(); lastFooter = "";
  }
  was = down;
  if (muted && millis() > muteUntil) { muted = false; drawHeader(); }
}

void setup() {
  pinMode(PIN_G, OUTPUT); pinMode(PIN_Y, OUTPUT); pinMode(PIN_R, OUTPUT); pinMode(PIN_BUZ, OUTPUT); pinMode(PIN_MUTE, INPUT_PULLUP);
  leds(0, 0, 0);
  tft.init(); tft.setRotation(1); tft.fillScreen(BG);
  splash("Starting...");
  connectWifi(); poll();
}

void loop() {
  checkButton();
  if (millis() - lastPoll > POLL_MS) { lastPoll = millis(); poll(); }
  if (haveData && linked) {
    if (millis() - lastFooterMs > 1000) drawFooter();                 // rotates tip / advisory / "updated Ns ago"
    if (millis() - lastHeaderMs > 30000) drawHeader();                // clock and Wi-Fi strength
  }
  delay(40);
}
