/**
 * Vercel Function — 接收 Cal.com Webhook，即時推播 LINE 通知
 * 取代 Make 的即時通知流程
 *
 * 環境變數：
 *   LINE_CHANNEL_TOKEN   LINE Messaging API Channel Access Token
 *   OWNER_LINE_USER_ID   店主的 LINE User ID（接收商家通知）
 *   CAL_WEBHOOK_SECRET   （選填）Cal.com Webhook 簽章密鑰，用來驗證來源
 *
 * Cal.com Webhook 設定：
 *   Subscriber URL: https://你的vercel網址/api/webhook
 *   Triggers: BOOKING_CREATED（必選），可加 BOOKING_CANCELLED
 */

const crypto = require("crypto");
const { pushLine, toTaiwanTime, extractBooking, loadTemplates, renderTemplate } = require("./_line");

module.exports = async function handler(req, res) {
  // 只接受 POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "僅接受 POST" });
  }

  const lineToken   = process.env.LINE_CHANNEL_TOKEN;
  const ownerId     = process.env.OWNER_LINE_USER_ID;
  const webhookSecret = process.env.CAL_WEBHOOK_SECRET;
  // 店主通知可走獨立的商家 bot（OWNER_LINE_CHANNEL_TOKEN）；沒設就退回官方帳號 lineToken
  const ownerToken  = process.env.OWNER_LINE_CHANNEL_TOKEN || lineToken;

  if (!lineToken) return res.status(500).json({ error: "LINE_CHANNEL_TOKEN 未設定" });
  if (!ownerId)   return res.status(500).json({ error: "OWNER_LINE_USER_ID 未設定" });

  try {
    // ── 選填：驗證 Cal.com 簽章，防止外部偽造 ──
    if (webhookSecret) {
      const signature = req.headers["x-cal-signature-256"];
      const rawBody = JSON.stringify(req.body);
      const expected = crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex");

      if (signature !== expected) {
        console.error("Webhook 簽章驗證失敗");
        return res.status(401).json({ error: "簽章驗證失敗" });
      }
    }

    const body = req.body;
    const triggerEvent = body.triggerEvent || "";
    const payload = body.payload || {};

    console.log("Webhook received:", triggerEvent);

    // 只處理「預約建立」與「預約改期」兩種事件
    const isCreate     = triggerEvent === "BOOKING_CREATED";
    const isReschedule = triggerEvent === "BOOKING_RESCHEDULED";
    if (!isCreate && !isReschedule) {
      return res.status(200).json({ ok: true, skipped: triggerEvent });
    }

    // 取出預約資訊
    // 註：改期事件的 payload.startTime 已經是「新的」時間，直接沿用即可
    const bk = extractBooking(payload);
    const tw = bk.startTime ? toTaiwanTime(bk.startTime) : null;
    const timeStr = tw ? tw.full : "（時間未知）";

    // 讀取自訂模板（存在 Cal.com 隱藏方案；讀不到就用內建預設）
    let templates = null;
    if (process.env.CAL_API_KEY && process.env.CAL_USERNAME) {
      templates = await loadTemplates(process.env.CAL_API_KEY, process.env.CAL_USERNAME);
    }

    // 可代入模板的變數
    const vars = {
      "方案": bk.title,
      "加購": bk.addons ? "加購：" + bk.addons : "",
      "時間": timeStr,
      "時長": (bk.length || "?"),
      "姓名": bk.name || "未提供",
      "電話": bk.phone || "未提供",
      // 備註 / 信箱 為純文字（前綴寫在模板，例如「📝 備註：{備註}」），空值整行移除
      "備註": bk.note || "",
      "信箱": bk.email || ""
    };

    // 內建預設訊息（模板讀不到時的後備）
    const addonLine = bk.addons ? "加購：" + bk.addons + "\n" : "";
    // 店主訊息附上備註、信箱（空值則不出現，不留空行）
    const ownerExtra = (bk.note ? "\n📝 備註：" + bk.note : "") + (bk.email ? "\n✉️ Email：" + bk.email : "");

    // 新預約
    const defaultOwner =
      "🔔 新預約通知\n\n📋 " + bk.title + "\n" + addonLine +
      "📅 " + timeStr + "\n⏱ " + (bk.length || "?") + " 分鐘\n" +
      "👤 " + (bk.name || "未提供") + "\n📱 " + (bk.phone || "未提供") + ownerExtra;
    const defaultCustomer =
      "✅ 預約確認\n\n感謝您的預約！\n\n📋 " + bk.title + "\n" + addonLine +
      "📅 " + timeStr + "\n⏱ " + (bk.length || "?") + " 分鐘\n\n" +
      "屆時期待為您服務 💆\n如需取消或改期，請直接回覆訊息。";

    // 改期
    const defaultOwnerRe =
      "🔄 預約改期通知\n\n📋 " + bk.title + "\n" + addonLine +
      "📅 新時間：" + timeStr + "\n⏱ " + (bk.length || "?") + " 分鐘\n" +
      "👤 " + (bk.name || "未提供") + "\n📱 " + (bk.phone || "未提供") + ownerExtra;
    const defaultCustomerRe =
      "🔄 預約已改期\n\n您的預約時間已更新：\n\n📋 " + bk.title + "\n" + addonLine +
      "📅 新時間：" + timeStr + "\n⏱ " + (bk.length || "?") + " 分鐘\n\n" +
      "期待為您服務 💆\n如需再次調整，請直接回覆訊息。";

    // 依事件類型選用對應模板 / 後備訊息
    const ownerTplKey     = isReschedule ? "改期通知-店主" : "新預約-店主";
    const customerTplKey  = isReschedule ? "改期通知-客人" : "預約確認-客人";
    const ownerDefault    = isReschedule ? defaultOwnerRe : defaultOwner;
    const customerDefault = isReschedule ? defaultCustomerRe : defaultCustomer;

    // ── 1. 通知店主 ──
    const ownerMsg = (templates && templates[ownerTplKey])
      ? renderTemplate(templates[ownerTplKey], vars)
      : ownerDefault;

    const ownerResult = await pushLine(ownerId, ownerMsg, ownerToken);

    // ── 2. 通知客人（如果有 lineUserId）──
    let customerResult = { ok: false, body: "無 lineUserId" };
    if (bk.lineUserId) {
      const customerMsg = (templates && templates[customerTplKey])
        ? renderTemplate(templates[customerTplKey], vars)
        : customerDefault;

      customerResult = await pushLine(bk.lineUserId, customerMsg, lineToken);
    }

    console.log("Owner push:", ownerResult.ok, "Customer push:", customerResult.ok);

    return res.status(200).json({
      ok: true,
      owner: ownerResult.ok,
      customer: customerResult.ok
    });

  } catch (err) {
    console.error("Webhook error:", err);
    // 即使出錯也回 200，避免 Cal.com 一直重試
    return res.status(200).json({ ok: false, error: err.message });
  }
};
