
let total = 0;
const form = document.getElementById('shopping-form');
const list = document.getElementById('shopping-list');
const totalDisplay = document.getElementById('total');

form.addEventListener('submit', function(e) {
    e.preventDefault();
    const item = document.getElementById('item').value;
    const price = parseFloat(document.getElementById('price').value);
    const category = document.getElementById('category').value;
    const buyer = document.getElementById('buyer').value;
    const date = document.getElementById('date').value;
    const notes = document.getElementById('notes').value;

    const entry = document.createElement('div');
    entry.className = 'entry';
    entry.innerHTML = `<strong>${item}</strong> - ${price.toFixed(2)}€<br>
                       Κατηγορία: ${category}<br>
                       Αγόρασε: ${buyer} | Ημερομηνία: ${date}<br>
                       ${notes ? '📝 ' + notes : ''}`;
    list.appendChild(entry);

    total += price;
    totalDisplay.textContent = total.toFixed(2);
    form.reset();
});

function exportToText() {
    let data = '';
    list.querySelectorAll('.entry').forEach(div => {
        data += div.innerText + '\n---\n';
    });
    const blob = new Blob([data], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ta_psonia_mas.txt';
    a.click();
}

function clearList() {
    if (confirm('Είσαι σίγουρος ότι θέλεις να διαγράψεις τη λίστα;')) {
        list.innerHTML = '';
        total = 0;
        totalDisplay.textContent = total.toFixed(2);
    }
}

function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
}
