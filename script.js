
const form = document.getElementById('shopping-form');
const list = document.getElementById('shopping-list');
const totalDisplay = document.getElementById('total');
let total = 0;

form.addEventListener('submit', function(e) {
    e.preventDefault();
    const item = document.getElementById('item').value;
    const price = parseFloat(document.getElementById('price').value);
    const category = document.getElementById('category').value;
    const buyer = document.getElementById('buyer').value;
    const date = document.getElementById('date').value;

    const entry = document.createElement('div');
    entry.textContent = `${item} - ${price.toFixed(2)}€ - ${category} - ${buyer} - ${date}`;
    list.appendChild(entry);

    total += price;
    totalDisplay.textContent = total.toFixed(2);

    form.reset();
});

function exportToText() {
    let data = '';
    list.querySelectorAll('div').forEach(div => {
        data += div.textContent + '\n';
    });
    const blob = new Blob([data], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ta_psonia_mas.txt';
    a.click();
}
