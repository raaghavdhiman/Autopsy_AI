// Shop Demo cart & pricing logic.
const PRODUCTS = [
  { id: 'mug', name: 'Coffee Mug', price: 12.0 },
  { id: 'tee', name: 'T-Shirt', price: 25.0 },
  { id: 'cap', name: 'Baseball Cap', price: 8.5 },
];

const COUPONS = {
  SAVE10: { type: 'percent', value: 10 },
  SAVE50: { type: 'percent', value: 50 },
  FLAT20: { type: 'fixed', value: 20 },
};

const state = { items: {}, coupons: [], fixedDiscount: 0, message: '', order: null };

function findProduct(id) {
  return PRODUCTS.find((p) => p.id === id);
}

function addItem(id) {
  state.items[id] = (state.items[id] || 0) + 1;
}

function setQuantity(id, qty) {
  const q = parseInt(qty, 10);
  if (isNaN(q)) return;
  if (q === 0) {
    delete state.items[id];
    return;
  }
  state.items[id] = q;
}

function removeItem(id) {
  delete state.items[id];
}

function subtotal() {
  return Object.entries(state.items).reduce((sum, [id, qty]) => sum + findProduct(id).price * qty, 0);
}

function applyCoupon(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (!code) {
    state.message = 'Please enter a coupon code.';
    return false;
  }
  const coupon = COUPONS[code];
  if (!coupon) {
    state.message = 'Invalid coupon code.';
    return false;
  }
  if (coupon.type === 'fixed') {
    if (state.coupons.includes(code)) {
      state.message = 'Coupon already applied.';
      return false;
    }
    // Fixed coupons can never exceed the order value.
    state.fixedDiscount = Math.min(coupon.value, subtotal());
  }
  state.coupons.push(code);
  state.message = 'Coupon ' + code + ' applied.';
  return true;
}

function discountAmount() {
  const sub = subtotal();
  let percent = 0;
  for (const code of state.coupons) {
    const c = COUPONS[code];
    if (c.type === 'percent') percent += c.value;
  }
  return round2((sub * percent) / 100 + state.fixedDiscount);
}

function total() {
  return round2(subtotal() - discountAmount());
}

function checkout() {
  if (Object.keys(state.items).length === 0) {
    state.message = 'Your cart is empty.';
    return null;
  }
  state.order = { id: 'ORD-' + Math.floor(Math.random() * 90000 + 10000), total: total() };
  state.message = 'Order placed.';
  return state.order;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
