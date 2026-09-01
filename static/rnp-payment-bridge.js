(() => {
  "use strict";

  // CRM bridge between the app-owned pay_schedule entity and the separate RNP app.
  // We mirror each payment row into a MULTIPLE string field on the CRM deal.
  // This avoids cross-app entity.item.get permissions while keeping row-level drilldown.
  const XML_ID = "MPS_PAYMENT_ROWS";
  const FIELD_CODE = "MPS_PAYMENT_ROWS";
  const ENTITY = "pay_schedule";
  const AUTO_SYNC_KEY = "mavisRnpPaymentMirrorLastFullSyncV3";
  const AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

  let fieldName = "";
  let syncingCurrent = false;
  let syncingAll = false;
  let successObserverBusy = false;

  function bxInit() {
    return new Promise((resolve, reject) => {
      if (typeof BX24 === "undefined") {
        reject(new Error("BX24.js недоступен. Откройте приложение из Bitrix24."));
        return;
      }
      try { BX24.init(() => resolve()); } catch (error) { reject(error); }
    });
  }

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      BX24.callMethod(method, params, (result) => {
        if (result.error()) {
          const error = new Error(result.error_description() || result.error());
          error.code = result.error();
          reject(error);
          return;
        }
        resolve({
          data: result.data(),
          total: typeof result.total === "function" ? result.total() : null
        });
      });
    });
  }

  function batch(calls) {
    return new Promise((resolve, reject) => {
      BX24.callBatch(calls, (results) => {
        if (!results) {
          reject(new Error("Bitrix не вернул batch-результат."));
          return;
        }
        resolve(results);
      }, false);
    });
  }

  async function listAll(method, params = {}) {
    const first = await call(method, { ...params, start: 0 });
    const rows = Array.isArray(first.data) ? [...first.data] : [];
    const total = Number(first.total);
    if (!Number.isFinite(total) || total <= rows.length) return rows;

    const starts = [];
    for (let start = 50; start < total; start += 50) starts.push(start);

    for (let offset = 0; offset < starts.length; offset += 40) {
      const chunk = starts.slice(offset, offset + 40);
      const calls = {};
      chunk.forEach((start, index) => {
        calls[`p${index}`] = { method, params: { ...params, start } };
      });
      const results = await batch(calls);
      chunk.forEach((_, index) => {
        const result = results[`p${index}`];
        if (!result || result.error()) return;
        const data = result.data();
        if (Array.isArray(data)) rows.push(...data);
      });
    }
    return rows;
  }

  function unwrap(value) {
    if (Array.isArray(value)) return value.length ? value[0] : "";
    return value ?? "";
  }

  function toNumber(value) {
    const parsed = Number.parseFloat(String(value ?? "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function roundMoney(value) {
    return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
  }

  function dateOnly(value) {
    return String(unwrap(value) || "").slice(0, 10);
  }

  function compactText(value, max = 120) {
    return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
  }

  function encodedItem(item) {
    const p = item?.PROPERTY_VALUES || {};
    const hasContractor = String(unwrap(p.HAS_CNTR) || "") === "Y";
    return JSON.stringify({
      d: dateOnly(p.PAY_DATE),
      a: roundMoney(unwrap(p.CLIENT_AMT)),
      c: hasContractor ? compactText(unwrap(p.CONTRACTOR), 80) : "",
      o: hasContractor ? compactText(unwrap(p.OTHER_CNTR), 120) : "",
      x: hasContractor ? roundMoney(unwrap(p.CNTR_AMT)) : 0,
      r: Number(unwrap(p.ROW_ORDER) || 0)
    });
  }

  async function getUserfields() {
    return listAll("crm.deal.userfield.list", { order: { SORT: "ASC" } });
  }

  async function ensureField() {
    if (fieldName) return fieldName;

    let fields = await getUserfields();
    let found = fields.find((field) => String(field.XML_ID || "").toUpperCase() === XML_ID);

    if (!found) {
      try {
        await call("crm.deal.userfield.add", {
          fields: {
            LABEL: "РНП · строки графика платежей",
            EDIT_FORM_LABEL: "РНП · строки графика платежей",
            LIST_COLUMN_LABEL: "РНП · строки графика платежей",
            LIST_FILTER_LABEL: "РНП · строки графика платежей",
            USER_TYPE_ID: "string",
            FIELD_NAME: FIELD_CODE,
            XML_ID,
            MULTIPLE: "Y",
            MANDATORY: "N",
            SHOW_FILTER: "N",
            SHOW_IN_LIST: "N",
            EDIT_IN_LIST: "N",
            IS_SEARCHABLE: "N",
            SORT: 9990,
            SETTINGS: { ROWS: 1 }
          }
        });
      } catch (error) {
        // Another tab/process may have created it in parallel. Re-read before failing.
        fields = await getUserfields();
        found = fields.find((field) => String(field.XML_ID || "").toUpperCase() === XML_ID);
        if (!found) {
          throw new Error(
            "Не удалось создать служебное CRM-поле MPS_PAYMENT_ROWS. " +
            "Первый запуск выполните под CRM-администратором. " +
            (error.message || error)
          );
        }
      }

      if (!found) {
        fields = await getUserfields();
        found = fields.find((field) => String(field.XML_ID || "").toUpperCase() === XML_ID);
      }
    }

    fieldName = String(found?.FIELD_NAME || "");
    if (!fieldName) throw new Error("Служебное поле MPS_PAYMENT_ROWS не найдено после создания.");

    if (String(found?.MULTIPLE || "N") !== "Y") {
      throw new Error(
        `Поле ${fieldName} существует, но оно не множественное. ` +
        "Его нужно пересоздать как MULTIPLE=Y, иначе строки графика будут теряться."
      );
    }

    return fieldName;
  }

  function dealIdFromPage() {
    const config = window.MAVIS_PAYMENT_CONFIG || {};
    if (config.serverDealId) return String(config.serverDealId);
    try {
      const info = BX24.placement.info();
      return String(info?.options?.ID || "");
    } catch (_) {
      return "";
    }
  }

  function sortItems(items) {
    return [...items].sort((a, b) => {
      const ar = Number(unwrap(a?.PROPERTY_VALUES?.ROW_ORDER) || 0);
      const br = Number(unwrap(b?.PROPERTY_VALUES?.ROW_ORDER) || 0);
      return ar - br || Number(a.ID || 0) - Number(b.ID || 0);
    });
  }

  async function updateDealMirror(dealId, items, mirrorField) {
    const values = sortItems(items).map(encodedItem);
    await call("crm.deal.update", {
      id: Number(dealId),
      fields: { [mirrorField]: values }
    });
    return values.length;
  }

  async function syncCurrentDeal() {
    if (syncingCurrent) return;
    const dealId = dealIdFromPage();
    if (!dealId) return;

    syncingCurrent = true;
    try {
      const mirrorField = await ensureField();
      const items = await listAll("entity.item.get", {
        ENTITY,
        SORT: { ID: "ASC" },
        FILTER: { PROPERTY_DEAL_ID: Number(dealId) }
      });
      const count = await updateDealMirror(dealId, items, mirrorField);
      console.info(`[RNP bridge] Сделка ${dealId}: синхронизировано строк ${count}`);
      return count;
    } finally {
      syncingCurrent = false;
    }
  }

  function ensureStatusElement() {
    let element = document.getElementById("rnp-payment-bridge-status");
    if (element) return element;

    const revenueHeader = document.querySelector(".revenue-header");
    if (!revenueHeader) return null;

    element = document.createElement("div");
    element.id = "rnp-payment-bridge-status";
    element.className = "notice hidden";
    element.style.marginTop = "12px";
    revenueHeader.insertAdjacentElement("afterend", element);
    return element;
  }

  function ensureManualSyncButton() {
    if (!isRevenuePage()) return null;
    let button = document.getElementById("rnp-payment-bridge-sync");
    if (button) return button;
    const header = document.querySelector(".revenue-header");
    if (!header) return null;
    const actions = header.querySelector("button")?.parentElement || header;
    button = document.createElement("button");
    button.type = "button";
    button.id = "rnp-payment-bridge-sync";
    button.className = "button button-secondary";
    button.style.marginLeft = "8px";
    button.textContent = "Синхронизировать РНП";
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await fullSync({ force: true, visible: true });
      } catch (error) {
        console.error("[RNP bridge] manual sync:", error);
        setStatus(error.message || String(error), "error");
      } finally {
        button.disabled = false;
      }
    });
    if (actions === header) header.appendChild(button);
    else actions.appendChild(button);
    return button;
  }

  function setStatus(text, kind = "info") {
    const element = ensureStatusElement();
    if (!element) return;
    element.textContent = text;
    element.classList.remove("hidden", "notice-error", "notice-success");
    if (kind === "error") element.classList.add("notice-error");
    if (kind === "success") element.classList.add("notice-success");
    try { BX24.fitWindow(); } catch (_) {}
  }

  async function fullSync({ force = false, visible = true } = {}) {
    if (syncingAll) return;

    const last = Number(localStorage.getItem(AUTO_SYNC_KEY) || 0);
    if (!force && last && Date.now() - last < AUTO_SYNC_INTERVAL_MS) return;

    syncingAll = true;
    try {
      const mirrorField = await ensureField();
      if (visible) setStatus("РНП: синхронизирую существующие графики платежей…");

      const items = await listAll("entity.item.get", {
        ENTITY,
        SORT: { ID: "ASC" }
      });

      const groups = new Map();
      for (const item of items) {
        const dealId = String(unwrap(item?.PROPERTY_VALUES?.DEAL_ID) || "").trim();
        if (!dealId) continue;
        if (!groups.has(dealId)) groups.set(dealId, []);
        groups.get(dealId).push(item);
      }

      const deals = [...groups.entries()];
      if (!items.length) {
        const message = "РНП-мост не нашёл ни одной строки pay_schedule. Если в «Чистой выручке» есть суммы, нажмите «Синхронизировать РНП» и пришлите текст ошибки.";
        if (visible) setStatus(message, "error");
        throw new Error(message);
      }
      let success = 0;
      let failed = 0;

      for (let offset = 0; offset < deals.length; offset += 35) {
        const chunk = deals.slice(offset, offset + 35);
        const calls = {};

        chunk.forEach(([dealId, rows], index) => {
          calls[`u${index}`] = {
            method: "crm.deal.update",
            params: {
              id: Number(dealId),
              fields: { [mirrorField]: sortItems(rows).map(encodedItem) }
            }
          };
        });

        const results = await batch(calls);
        chunk.forEach((_, index) => {
          const result = results[`u${index}`];
          if (result && !result.error()) success += 1;
          else failed += 1;
        });

        if (visible) {
          setStatus(
            `РНП: синхронизация ${Math.min(offset + chunk.length, deals.length)} / ${deals.length}. ` +
            `Успешно ${success}, ошибок ${failed}.`,
            failed ? "error" : "info"
          );
        }
      }

      localStorage.setItem(AUTO_SYNC_KEY, String(Date.now()));
      const message =
        `РНП подключён к графику платежей. Сделок: ${success}, строк: ${items.length}` +
        (failed ? `, ошибок: ${failed}.` : ".");
      if (visible) setStatus(message, failed ? "error" : "success");
      console.info(`[RNP bridge] ${message}`);
      return { deals: deals.length, rows: items.length, success, failed };
    } finally {
      syncingAll = false;
    }
  }

  function isAdmin() {
    try {
      if (typeof BX24.isAdmin === "function") return BX24.isAdmin() === true;
    } catch (_) {}
    return false;
  }

  function isRevenuePage() {
    return !!document.getElementById("revenue-app");
  }

  function isPaymentPage() {
    return !!document.getElementById("payment-app");
  }

  function observePaymentSave() {
    const success = document.getElementById("app-success");
    if (!success) return;

    const observer = new MutationObserver(async () => {
      if (successObserverBusy) return;
      const visible = !success.classList.contains("hidden");
      const text = String(success.textContent || "");
      if (!visible || !/график платежей сохран/i.test(text) || /рнп синхронизирован/i.test(text)) return;

      successObserverBusy = true;
      try {
        await syncCurrentDeal();
        success.textContent = "График платежей сохранён. Итоговые поля сделки обновлены. РНП синхронизирован.";
      } catch (error) {
        console.error("[RNP bridge] sync after save:", error);
        success.textContent = "График платежей сохранён, но РНП не синхронизирован: " + (error.message || error);
      } finally {
        successObserverBusy = false;
      }
    });

    observer.observe(success, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"]
    });
  }

  async function bootstrap() {
    try {
      await bxInit();

      // Field is created once by an admin. Existing users only reuse it.
      await ensureField();

      if (isPaymentPage()) {
        observePaymentSave();
        // Keep the currently opened deal mirrored even before the next manual edit.
        window.setTimeout(() => {
          syncCurrentDeal().catch((error) => console.error("[RNP bridge] current sync:", error));
        }, 700);
      }

      // Historical backfill must not depend on BX24.isAdmin(): on some portals it returns false
      // even though the application token can read pay_schedule and update CRM deals.
      // ensureField() above is the only operation that may actually require admin rights.
      if (isRevenuePage()) ensureManualSyncButton();
      window.setTimeout(() => {
        fullSync({ force: false, visible: isRevenuePage() })
          .catch((error) => {
            console.error("[RNP bridge] full sync:", error);
            if (isRevenuePage()) setStatus(error.message || String(error), "error");
          });
      }, 900);
    } catch (error) {
      console.error("[RNP bridge] init:", error);
      if (isRevenuePage()) setStatus(error.message || String(error), "error");
    }
  }

  if (typeof BX24 !== "undefined") bootstrap();
})();
