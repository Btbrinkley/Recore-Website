document.addEventListener('DOMContentLoaded', function () {
var toggle = document.querySelector('.nav-toggle');
var links = document.querySelector('.nav-links');
if (toggle && links) {
toggle.addEventListener('click', function () {
var isOpen = links.classList.toggle('open');
toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
});
links.querySelectorAll('a').forEach(function (link) {
link.addEventListener('click', function () {
links.classList.remove('open');
toggle.setAttribute('aria-expanded', 'false');
});
});
}
var yearEls = document.querySelectorAll('[data-year]');
yearEls.forEach(function (el) {
el.textContent = new Date().getFullYear();
});
});
