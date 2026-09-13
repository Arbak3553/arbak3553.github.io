// Order dispatch: the request really leaves the page — composed as text and
// handed to Telegram (share sheet) or the mail client. Plus the reverse-geocode
// place name shown on stage and embedded into the order.

// orders land in their own box; hello@ stays the public contact address
const EMAIL = 'order@rel-ef.ru';

/** Engraving surcharge, rubles (manual work after casting). */
export const ENGRAVE_PRICE = 990;

/** Retail prices per form and weight (unit-economics v2 ladder, x900 endings).
 * Pendant tiers and ring subtle/classic, signet classic/statement come straight
 * from the ladder; signet subtle and disc statement follow its ~3000 step. */
export const PRICES = {
  disc:     { subtle: 11900, classic: 14900, statement: 17900 },
  signet:   { subtle: 14900, classic: 17900, statement: 24900 },
  earrings: { subtle: 9900,  classic: 11900, statement: 13900 },
  pendant:  { subtle: 7900,  classic: 8900,  statement: 10900 },
};
export const fmtRub = n => n.toLocaleString('ru-RU') + ' ₽';
export function priceOf(state, view) {
  return PRICES[state.form][state.weight] + (engraveLine(state, view) ? ENGRAVE_PRICE : 0);
}

import { DISC_W } from './disc.js';
import { EAR_W } from './earring.js';
import { PEND_W } from './pendant.js';
import { WEIGHT_FACE, CLASSIC_TRIM, PHI } from './signet.js';

const FORM_LABEL = { disc: 'Кольцо-диск', signet: 'Печатка', earrings: 'Серьги', pendant: 'Подвеска' };
const WEIGHT_LABEL = { subtle: 'S', classic: 'M', statement: 'L' };

const mm = v => v.toFixed(1).replace('.', ',').replace(',0', '');

/** Real millimetres of the piece, derived from the very constants the geometry
 *  is built from — the signet face is a flat tangent pad, so its length is
 *  2*FACE_LEN and its width follows the axial trim. */
export function dimsOf(form, weight, sizeMm) {
  if (form === 'signet') {
    const R_I = sizeMm / 2, T = sizeMm * PHI ** -5, R_O = R_I + T;
    const W = PHI ** -3 * ((R_O + R_I) / 2);
    const len = (WEIGHT_FACE[weight] || 0.5) * R_O;
    const wid = weight === 'subtle' ? W : len * (weight === 'classic' ? CLASSIC_TRIM : 1);
    return { short: `${mm(2 * wid)} × ${mm(2 * len)} мм`, full: `площадка ${mm(2 * wid)} × ${mm(2 * len)} мм, металл ${mm(T)} мм` };
  }
  const t = form === 'earrings' ? (EAR_W[weight] || EAR_W.classic)
          : form === 'pendant' ? (PEND_W[weight] || PEND_W.classic)
          : (DISC_W[weight] || DISC_W.classic);
  const d = mm(2 * t.R);
  const what = form === 'earrings' ? 'диски' : form === 'pendant' ? 'медальон' : 'диск';
  return { short: `${d} мм`, full: `${what} ${d} мм в диаметре, толщина ${mm(t.T)} мм` };
}
const CLOSURE_LABEL = { stud: 'пусеты', leverback: 'английский замок', hook: 'крючки' };
const DETAIL_LABEL = { low: 'низкая', medium: 'средняя', high: 'высокая' };
export const SHOULDER_LABEL = { straight: 'прямые', classic: 'классика', curved: 'плавные' };
export const BAND_LABEL = { flat: 'плоская', classic: 'классика', 'd-shaped': 'полукруглая' };

export function engraveLine(state, view) {
  if (state.engrave === 'none') return null;
  const text = state.engrave === 'custom'
    ? (state.engraveText || '').trim()
    : `${view.lat.toFixed(4)}N ${view.lon.toFixed(4)}E`;
  if (!text) return null;
  const where = state.form === 'signet' || state.form === 'disc'
    ? 'внутренняя сторона шинки' : 'тыльная сторона диска';
  return { text, where };
}

// Технологическое ядро заявки: всё, что описывает изделие. Общее для текста
// владельцу и наряда ювелиру — расходятся только персоналка и цены.
function specLines({ state, view, grams, placeName, withPrices }) {
  const lines = [];
  const fastening = state.form === 'earrings' ? ` · закрепка: ${CLOSURE_LABEL[state.closure]}` : '';
  lines.push(`Модель: ${FORM_LABEL[state.form]} · размер ${WEIGHT_LABEL[state.weight]} · серебро 925${fastening}`);
  lines.push(`Габариты: ${dimsOf(state.form, state.weight, state.sizeMm).full}`);
  if (state.form === 'pendant') {
    lines.push(`Закрепка: ${state.pendMount === 'one' ? 'одно ушко (бейл, подвеска скользит по цепи)' : 'два ушка (вшита в цепь)'}`);
    lines.push(`Цепь: ${state.chainCm} см, серебро 925 — готовая, крепится к литым ушкам при сборке`);
  }
  lines.push(`Место: ${placeName ? placeName + ' ' : ''}(${view.lat.toFixed(5)}, ${view.lon.toFixed(5)}), поворот ${Math.round(view.bearing * 180 / Math.PI)}°`);
  lines.push(`Рельеф: высота ${(1 + 4 * state.heightPct / 100).toFixed(1)} мм · детализация ${DETAIL_LABEL[state.detail]}${state.form !== 'signet' ? ` · уровень поля ${state.basePct}%` : ''}`);
  if (state.form === 'signet') lines.push(`Плечи: ${SHOULDER_LABEL[state.shoulder]} · шинка: ${BAND_LABEL[state.band]}`);
  lines.push(`Отделка: ${state.finish === 'satin' ? 'сатинирование (матовая штриховка)' : 'глянцевая полировка'}`);
  const e = engraveLine(state, view);
  lines.push(e
    ? `Гравировка: «${e.text}» (${e.where})${withPrices ? ` — +${ENGRAVE_PRICE} ₽` : ' — лазером после литья, в STL не входит'}`
    : 'Гравировка: без');
  if (state.form !== 'earrings' && state.form !== 'pendant') lines.push(`Размер: ${state.sizeMm} (RU, внутренний диаметр)`);
  lines.push(`Расчётный вес: ${grams.toFixed(1)} г${state.form === 'earrings' ? ' (пара)' : ''}`);
  return lines;
}

export function orderText({ state, view, grams, placeName, shareUrl, name, channel, contact }) {
  const lines = [];
  lines.push(`Предзаказ REL'EF — конструктор · цена ${fmtRub(priceOf(state, view))}`);
  if (name) lines.push(`Имя: ${name}`);
  lines.push(`Связь: ${channel === 'phone' ? 'телефон' : 'Telegram'} ${contact}`);
  lines.push(...specLines({ state, view, grams, placeName, withPrices: true }));
  lines.push(`Итого: ${fmtRub(priceOf(state, view))} — серебро 925, работа и бесплатная доставка по России; цена фиксируется за заявкой, оплата при запуске в производство`);
  lines.push(`Дизайн: ${shareUrl}`);
  return lines.join('\n');
}

// Наряд для литейки: техника без имён, контактов, цен и ссылок — можно
// пересылать как есть. Номер заказа добавляет воркер (сквозной счётчик).
export function jewelerText({ state, view, grams, placeName }) {
  const lines = ['В литьё · серебро 925'];
  lines.push(...specLines({ state, view, grams, placeName, withPrices: false }));
  lines.push('STL приложен: одно замкнутое тело, размеры в мм.');
  return lines.join('\n');
}

export function sendViaTelegram(text, shareUrl) {
  const u = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(text)}`;
  window.open(u, '_blank', 'noopener');
}

export function sendViaMail(text) {
  location.href = `mailto:${EMAIL}?subject=${encodeURIComponent("Предзаказ: украшение из конструктора REL'EF")}&body=${encodeURIComponent(text)}`;
}

/** Reverse geocode for the stage caption; falls back to bare coordinates. */
export async function placeNameOf(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&accept-language=ru&lat=${lat}&lon=${lon}`);
    const j = await r.json();
    const ad = j.address || {};
    const part = ad.county || ad.state || ad.city || ad.municipality || j.name;
    if (!part) return null;
    return ad.country && ad.country !== 'Россия' ? `${part}, ${ad.country}` : part;
  } catch (e) {
    return null;
  }
}
