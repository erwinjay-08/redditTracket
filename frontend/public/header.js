// header.js
function goPage(page) {
  const current = window.location.pathname.split("/").pop().toLowerCase();
  if(current === page.toLowerCase()) return;
  window.location.href = page;
}

function setActiveTab() {
  const page = window.location.pathname.split("/").pop().toLowerCase(); // lowercase
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => tab.classList.remove('active'));

  switch(page) {
    case 'index.html':
    case '':
      document.getElementById('tab-index').classList.add('active');
      break;
    case 'user_ranking.html':
      document.getElementById('tab-userRanking').classList.add('active');
      break;
    case 'user_monthly_subs_performance.html':
      document.getElementById('tab-userMonthly').classList.add('active');
      break;
    case 'sub_post_timing.html':
      document.getElementById('tab-subPostTiming').classList.add('active');
      break;
  }

  // Show extras only on index
  const extras = document.getElementById('headerExtras');
  if(extras) extras.style.display = (page === 'index.html' || page === '') ? 'flex' : 'none';
}

let nsfwMode = false;

// Restore saved preference from localStorage
const savedMode = localStorage.getItem('subtracker-mode');
if (savedMode === 'nsfw') {
  nsfwMode = true;
  document.documentElement.setAttribute('data-mode', 'nsfw');
} else {
  nsfwMode = false;
  document.documentElement.setAttribute('data-mode', 'sfw');
}

// Optional: update any UI element showing the current mode
const modeEl = document.getElementById('m-mode');
if (modeEl) {
  modeEl.textContent = nsfwMode ? '18+' : 'Safe';
  modeEl.style.color = nsfwMode ? '#c0392b' : '';
}

// Toggle function
function toggleMode() {
  nsfwMode = !nsfwMode;
  document.documentElement.setAttribute('data-mode', nsfwMode ? 'nsfw' : 'sfw');
  localStorage.setItem('subtracker-mode', nsfwMode ? 'nsfw' : 'sfw');
  if (modeEl) {
    modeEl.textContent = nsfwMode ? '18+' : 'Safe';
    modeEl.style.color = nsfwMode ? '#c0392b' : '';
  }
}


document.addEventListener('DOMContentLoaded', setActiveTab);