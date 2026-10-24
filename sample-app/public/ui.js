// Shop Demo UI bindings — renders state from cart.js.
const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2);

function render() {
  document.getElementById('products').innerHTML = PRODUCTS.map(
    (p) => `<div class="card" data-testid="product-${p.id}" data-id="${p.id}" data-price="${p.price}">
      <b>${p.name}</b><div>${money(p.price)}</div>
      <button data-testid="add-${p.id}" onclick="addItem('${p.id}');render()">Add to cart</button></div>`
  ).join('');
  document.getElementById('lines').innerHTML =
    Object.entries(state.items)
      .map(([id, qty]) => {
        const p = findProduct(id);
        return `<div class="line" data-testid="line-${id}" data-price="${p.price}">
        <span>${p.name}</span>
        <input type="number" data-testid="qty-${id}" value="${qty}" onchange="setQuantity('${id}', this.value);render()">
        <span>${money(p.price * qty)}</span>
        <button data-testid="remove-${id}" onclick="removeItem('${id}');render()">✕</button></div>`;
      })
      .join('') || '<div style="color:#888">Cart is empty</div>';
  document.getElementById('subtotal').textContent = money(subtotal());
  document.getElementById('discount').textContent = money(discountAmount());
  document.getElementById('total').textContent = money(total());
  document.getElementById('message').textContent = state.message;
  document.getElementById('order').innerHTML = state.order
    ? `<b data-testid="order-id">${state.order.id}</b> placed — charged <span data-testid="order-total">${money(state.order.total)}</span>`
    : '';
}

function onApply() {
  const input = document.getElementById('coupon');
  applyCoupon(input.value);
  input.value = '';
  render();
}

function onCheckout() {
  checkout();
  render();
}

render();
