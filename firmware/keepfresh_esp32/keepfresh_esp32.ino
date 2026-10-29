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

  With no attention items, the screen shows an animated all-clear home screen. When items need attention,
  it shows a color-coded warning card and pulses the buzzer for one minute, then returns to the home screen.
  The warning repeats every 30 minutes until the items are marked used/discarded in KeepFresh.
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
const unsigned long POLL_MS = 60000;
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
String led = "green", household = "", tip = "", advisory = "", devCode = "";
bool linked = true, serverOk = false, haveData = false, buzzerFlag = false;

unsigned long lastPoll = 0, lastOkMs = 0, muteUntil = 0, lastHeaderMs = 0;
bool muted = false;
bool warningActive = false, alertVisible = false;
String warningSignature = "";
unsigned long alertUntil = 0, nextAlertAt = 0, lastAlertPage = 0, lastHomeAnimation = 0;
int alertPage = 0, homeFrame = 0;

// ---------- outputs ----------
void leds(bool g, bool y, bool r) { digitalWrite(PIN_G, g); digitalWrite(PIN_Y, y); digitalWrite(PIN_R, r); }
void beep(int times, int ms = 150) { for (int i = 0; i < times; i++) { digitalWrite(PIN_BUZ, HIGH); delay(ms); digitalWrite(PIN_BUZ, LOW); delay(ms); } }

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

void drawIdleHome(bool force = false) {
  int cx = tft.width() / 2;
  if (force) {
    tft.fillScreen(BG); drawHeader();
    tft.fillRoundRect(14, 48, tft.width() - 28, 62, 12, PANEL);
    textCenter(cx, 58, 2, OLIVE, "YOUR FRIDGE", PANEL);
    textCenter(cx, 84, 2, CREAM, "ALL CLEAR", PANEL);
    textCenter(cx, 119, 1, MUTED, nTotal ? String(nTotal) + " foods staying fresh" : "Your fridge is ready", BG);
    tft.fillRoundRect(42, 267, tft.width() - 84, 34, 9, PANEL);
    textCenter(cx, 277, 1, MUTED, serverOk ? "Warnings will appear here" : "Offline - showing last status", PANEL);
  }
  // Redraw only the illustration area for a soft, low-flicker idle animation.
  tft.fillRect(cx - 105, 137, 210, 122, BG);
  int bounce = (homeFrame % 2) ? 4 : 0;
  tft.fillRoundRect(cx - 65, 190 + bounce, 130, 55, 8, BROWN);
  tft.drawRoundRect(cx - 65, 190 + bounce, 130, 55, 8, GOLD);
  for (int y = 203; y <= 233; y += 15) tft.drawLine(cx - 58, y + bounce, cx + 58, y + bounce, GOLD);
  tft.fillCircle(cx - 34, 179 - bounce, 18, GREEN);
  tft.fillCircle(cx, 169 + bounce, 22, ORANGE);
  tft.fillCircle(cx + 35, 180 - bounce, 17, RED);
  int sparkleX = cx - 82 + ((homeFrame * 23) % 165), sparkleY = 156 + ((homeFrame * 13) % 27);
  tft.fillCircle(sparkleX, sparkleY, 4, CREAM);
  homeFrame++;
}

void drawWarningScreen() {
  if (nRows <= 0) return;
  alertPage %= nRows;
  const Row& r = rows[alertPage];
  uint16_t col = levelColor(r.level);
  tft.fillScreen(CREAM);
  tft.fillRoundRect(8, 8, tft.width() - 16, tft.height() - 16, 16, PANEL);
  tft.fillRoundRect(8, 8, tft.width() - 16, 52, 16, col);
  String title = r.level == "Critical" ? "FOOD EXPIRED" : r.level == "Warning" ? "USE THIS TODAY" : "USE THIS SOON";
  textCenter(tft.width() / 2, 23, 2, CREAM, title, col);
  tft.fillCircle(tft.width() / 2, 104, 31, col);
  textCenter(tft.width() / 2, 81, 4, CREAM, "!", col);
  textCenter(tft.width() / 2, 148, 3, CREAM, clip(r.name, 22), PANEL);
  textCenter(tft.width() / 2, 183, 2, col, daysText(r.days), PANEL);
  if (r.qty.length()) textCenter(tft.width() / 2, 213, 1, MUTED, "Quantity: " + clip(r.qty, 28), PANEL);
  tft.fillRoundRect(22, 245, tft.width() - 44, 44, 9, col);
  textCenter(tft.width() / 2, 251, 1, CREAM, "Mark used or discard in KeepFresh", col);
  textCenter(tft.width() / 2, 270, 1, CREAM, "Item " + String(alertPage + 1) + " of " + String(nRows) + (muted ? "  |  BUZZER MUTED" : ""), col);
  lastAlertPage = millis();
}

void startAlertWindow() {
  unsigned long now = millis();
  alertVisible = true; alertUntil = now + 60000UL; nextAlertAt = now + REPEAT_ALARM_MS;
  alertPage = 0; drawWarningScreen();
}

void driveWarningBuzzer() {
  if (!warningActive || !alertVisible || muted) { digitalWrite(PIN_BUZ, LOW); return; }
  unsigned long phase = millis() % 4000UL;
  bool on = phase < 180UL || (phase >= 420UL && phase < 600UL);
  digitalWrite(PIN_BUZ, on ? HIGH : LOW);
}

void serviceWarningDisplay() {
  unsigned long now = millis();
  if (!warningActive) { if (linked && now - lastHomeAnimation >= 900UL) { lastHomeAnimation = now; drawIdleHome(); } return; }
  if (alertVisible && (int32_t)(now - alertUntil) >= 0) {
    alertVisible = false; digitalWrite(PIN_BUZ, LOW); drawIdleHome(true);
  } else if (!alertVisible && (int32_t)(now - nextAlertAt) >= 0) startAlertWindow();
  if (alertVisible && nRows > 1 && now - lastAlertPage >= 10000UL) { alertPage = (alertPage + 1) % nRows; drawWarningScreen(); }
  driveWarningBuzzer();
}

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
  if (WiFi.status() != WL_CONNECTED) { serverOk = false; connectWifi(); if (!haveData) splash("Wi-Fi reconnecting..."); return; }
  WiFiClientSecure secure; WiFiClient plain; HTTPClient http;
  secure.setInsecure();   // for production, pin your server certificate with secure.setCACert(...)
  String url = String(SERVER) + "/api/device/status";
  bool began = url.startsWith("https://") ? http.begin(secure, url) : http.begin(plain, url);
  if (!began) { serverOk = false; return; }
  http.setTimeout(8000); http.addHeader("x-device-key", DEVICE_KEY);
  int code = http.GET();
  if (code != 200) { http.end(); serverOk = false; if (!haveData) splash("Server error " + String(code)); return; }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, http.getString());
  http.end();
  if (err) { serverOk = false; return; }

  bool cameBack = !serverOk;
  serverOk = true; haveData = true; lastOkMs = millis();
  String cmd = doc["command"].isNull() ? "" : doc["command"].as<String>();
  if (cmd == "restart") ESP.restart();
  if (cmd == "test") { leds(1, 0, 0); delay(400); leds(0, 1, 0); delay(400); leds(0, 0, 1); delay(400); }
  if (cmd == "buzz") beep(3);

  applyStatus(doc);
  leds(led == "green", led == "yellow", led == "red");
  String sig;
  for (int i = 0; i < nRows; i++) sig += rows[i].name + ":" + rows[i].level + ":" + String(rows[i].days) + ";";
  bool wasWarning = warningActive;
  warningActive = buzzerFlag && linked;
  if (!linked) {
    warningActive = false; alertVisible = false; digitalWrite(PIN_BUZ, LOW); drawUnlinked();
  } else if (!warningActive) {
    bool cleared = wasWarning || warningSignature.length();
    warningSignature = ""; alertVisible = false; nextAlertAt = 0; digitalWrite(PIN_BUZ, LOW);
    if (cleared || cameBack) drawIdleHome(true);
  } else if (!wasWarning) {
    warningSignature = sig; startAlertWindow();
  } else if (sig != warningSignature) {
    warningSignature = sig;
    if (alertVisible) { alertPage = 0; drawWarningScreen(); }
  }
  serviceWarningDisplay();
}

// BOOT button: mute the buzzer for one hour, press again to un-mute
void checkButton() {
  static bool was = false; static unsigned long t = 0;
  bool down = digitalRead(PIN_MUTE) == LOW;
  if (down && !was && millis() - t > 300) {
    t = millis(); muted = !muted; muteUntil = muted ? millis() + MUTE_MS : 0;
    if (!muted) beep(1, 80);
    if (warningActive && alertVisible) drawWarningScreen(); else if (linked && haveData) drawIdleHome(true); else if (!linked) drawUnlinked();
  }
  was = down;
  if (muted && (int32_t)(millis() - muteUntil) >= 0) {
    muted = false;
    if (warningActive && alertVisible) drawWarningScreen(); else if (linked && haveData) drawIdleHome(true); else if (!linked) drawUnlinked();
  }
}

void setup() {
  pinMode(PIN_G, OUTPUT); pinMode(PIN_Y, OUTPUT); pinMode(PIN_R, OUTPUT); pinMode(PIN_BUZ, OUTPUT); pinMode(PIN_MUTE, INPUT_PULLUP);
  leds(0, 0, 0);
  tft.init(); tft.setRotation(1); tft.fillScreen(BG);
  splash("Starting...");
  connectWifi(); poll();
  if (haveData && linked && !warningActive) drawIdleHome(true);
}

void loop() {
  checkButton();
  if (millis() - lastPoll > POLL_MS) { lastPoll = millis(); poll(); }
  serviceWarningDisplay();
  if (haveData && linked && !warningActive && millis() - lastHeaderMs > 30000UL) drawIdleHome(true);
  delay(40);
}
