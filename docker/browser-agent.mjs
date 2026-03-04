#!/usr/bin/env node

import { createInterface } from "readline";
import { chromium } from "playwright";
import { resolve } from "path";

let browser = null;
let context = null;
let page = null;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function ensurePage() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  if (!context) {
    context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  }
  if (!page) {
    page = await context.newPage();
  }
  return page;
}

async function closeAll() {
  try {
    if (page) await page.close();
  } catch {}
  page = null;

  try {
    if (context) await context.close();
  } catch {}
  context = null;

  try {
    if (browser) await browser.close();
  } catch {}
  browser = null;
}

async function actionNavigate(payload) {
  const p = await ensurePage();
  await p.goto(payload.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const title = await p.title();
  return { ok: true, url: p.url(), title };
}

async function actionSnapshot() {
  const p = await ensurePage();
  const title = await p.title();
  const url = p.url();
  const bodyText = await p.evaluate(() => (document.body?.innerText || "").trim());
  const links = await p.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]"))
      .slice(0, 30)
      .map((a) => ({
        text: (a.textContent || "").trim().slice(0, 80),
        href: a.getAttribute("href") || "",
      }));
  });
  return {
    ok: true,
    url,
    title,
    text: bodyText.slice(0, 5000),
    links,
  };
}

async function actionClick(payload) {
  const p = await ensurePage();
  await p.locator(payload.selector).first().click({ timeout: 30000 });
  return { ok: true, url: p.url() };
}

async function actionType(payload) {
  const p = await ensurePage();
  const locator = p.locator(payload.selector).first();
  await locator.fill(payload.text || "", { timeout: 30000 });
  if (payload.submit) {
    await locator.press("Enter");
  }
  return { ok: true };
}

async function actionWaitFor(payload) {
  const p = await ensurePage();
  if (payload.text) {
    await p.getByText(payload.text, { exact: false }).first().waitFor({ timeout: 60000 });
    return { ok: true, condition: `text:${payload.text}` };
  }
  if (payload.textGone) {
    await p.getByText(payload.textGone, { exact: false }).first().waitFor({ state: "hidden", timeout: 60000 });
    return { ok: true, condition: `textGone:${payload.textGone}` };
  }
  const ms = Math.max(0, Number(payload.time || 1) * 1000);
  await p.waitForTimeout(ms);
  return { ok: true, condition: `time:${payload.time || 1}` };
}

async function actionScreenshot(payload) {
  const p = await ensurePage();
  const filename = payload.filename ? resolve("/workspace", payload.filename) : resolve("/workspace", `browser-${Date.now()}.png`);
  await p.screenshot({ path: filename, fullPage: !!payload.fullPage, type: payload.type === "jpeg" ? "jpeg" : "png" });
  return { ok: true, path: filename };
}

async function actionClose() {
  await closeAll();
  return { ok: true };
}

async function handleCommand(cmd) {
  const payload = cmd.payload || {};
  switch (cmd.action) {
    case "navigate":
      return actionNavigate(payload);
    case "snapshot":
      return actionSnapshot();
    case "click":
      return actionClick(payload);
    case "type":
      return actionType(payload);
    case "wait_for":
      return actionWaitFor(payload);
    case "screenshot":
      return actionScreenshot(payload);
    case "close":
      return actionClose();
    default:
      throw new Error(`Unknown browser action: ${cmd.action}`);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }

  try {
    const result = await handleCommand(cmd);
    emit({ id: cmd.id, ok: true, result });
  } catch (err) {
    emit({ id: cmd.id, ok: false, error: err.message || "browser action failed" });
  }
});

rl.on("close", async () => {
  await closeAll();
  process.exit(0);
});
