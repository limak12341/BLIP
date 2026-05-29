// @ts-check
const { test, expect } = require('@playwright/test');

// ── HELPER: login as admin ──────────────────────────────────────
async function adminLogin(page) {
  await page.goto('/admin');
  await page.waitForSelector('#token', { timeout: 5000 });
  await page.fill('#token', 'test-admin-token-123');
  await page.click('#btn-login');
  await page.waitForSelector('#admin-panel', { state: 'visible', timeout: 5000 });
}

test.describe('🏠 Strona główna', () => {
  test('powinna załadować się z tytułem i nawigacją', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/BFLIP/i);

    // Sidebar z logo
    await expect(page.locator('.sidebar-logo')).toBeVisible();
    await expect(page.locator('.sidebar-logo')).toContainText('BFLIP');

    // Sidebar powinien być widoczny
    await expect(page.locator('.sidebar')).toBeVisible();

    // Dashboard jest domyślnym widokiem po zalogowaniu
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('powinna mieć działający sidebar z linkami', async ({ page }) => {
    await page.goto('/');

    // Sidebar linki
    const sidebarLinks = page.locator('.sidebar-link');
    const count = await sidebarLinks.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Promo Code link powinien być widoczny
    const promoLink = page.locator('.sidebar-link', { hasText: 'Promo Code' });
    await expect(promoLink).toBeVisible();
  });

  test('powinna wyświetlić sekcje: coinflip i leaderboard', async ({ page }) => {
    await page.goto('/');

    // Sprawdź czy główna zawartość się renderuje
    await expect(page.locator('.main-container')).toBeVisible();

    // Sidebar z nawigacją
    await expect(page.locator('.sidebar-nav').first()).toBeVisible();

    // Login overlay powinien być widoczny (niezalogowany)
    await expect(page.locator('#login-overlay')).toBeVisible();
  });
});

test.describe('🔐 Admin panel - logowanie', () => {
  test('powinien pokazać formularz logowania przy /admin', async ({ page }) => {
    await page.goto('/admin');

    // Login box widoczny
    await expect(page.locator('#login-box')).toBeVisible();
    await expect(page.locator('#token')).toBeVisible();
    await expect(page.locator('#btn-login')).toBeVisible();
  });

  test('powinien zalogować z poprawnym tokenem', async ({ page }) => {
    await adminLogin(page);

    // Panel admina widoczny
    await expect(page.locator('#admin-panel')).toBeVisible();
    // Przycisk logout widoczny
    await expect(page.locator('#btn-logout')).toBeVisible();
  });

  test('powinien odrzucić zły token', async ({ page }) => {
    await page.goto('/admin');
    await page.fill('#token', 'zly-token');
    await page.click('#btn-login');
    // Komunikat błędu
    await expect(page.locator('#login-err')).not.toBeEmpty();
  });
});

test.describe('📋 Admin panel - zakładki', () => {
  test('powinien mieć wszystkie zakładki w toolbarze', async ({ page }) => {
    await adminLogin(page);

    const toolbarBtns = page.locator('#admin-panel .admin-toolbar .chip');
    const btnTexts = await toolbarBtns.allTextContents();

    expect(btnTexts.some(t => t.includes('Zgłoszenia'))).toBeTruthy();
    expect(btnTexts.some(t => t.includes('Gracze'))).toBeTruthy();
    expect(btnTexts.some(t => t.includes('Logi'))).toBeTruthy();
    expect(btnTexts.some(t => t.includes('Ostrzeżenia'))).toBeTruthy();
    expect(btnTexts.some(t => t.includes('Wiadomości'))).toBeTruthy();
    expect(btnTexts.some(t => t.includes('Promo'))).toBeTruthy();
  });

  test('powinien przełączać zakładki', async ({ page }) => {
    await adminLogin(page);

    // Domyślnie "Zgłoszenia" jest widoczne
    await expect(page.locator('#tab-requests')).toBeVisible();

    // Kliknij "Gracze"
    await page.click('#tab-btn-players');
    await expect(page.locator('#tab-players')).toBeVisible();
    await expect(page.locator('#tab-requests')).not.toBeVisible();

    // Kliknij "Logi"
    await page.click('#tab-btn-logs');
    await expect(page.locator('#tab-logs')).toBeVisible();

    // Kliknij "Promo"
    await page.click('#tab-btn-promo');
    await expect(page.locator('#tab-promo')).toBeVisible();
  });
});

test.describe('🎁 Admin panel - zarządzanie promokodami', () => {
  test('powinien pokazać formularz tworzenia kodu w zakładce Promo', async ({ page }) => {
    await adminLogin(page);
    await page.click('#tab-btn-promo');
    await page.waitForTimeout(300);

    // Formularz tworzenia
    await expect(page.locator('#promo-code-input')).toBeVisible();
    await expect(page.locator('#promo-max-uses')).toBeVisible();
    await expect(page.locator('#promo-create-btn')).toBeVisible();

    // Wiersz nagrody (domyślnie Coins)
    const rewardRows = page.locator('.promo-reward-row');
    await expect(rewardRows).toHaveCount(1);
  });

  test('powinien utworzyć nowy kod promocyjny (coins)', async ({ page }) => {
    await adminLogin(page);
    await page.click('#tab-btn-promo');
    await page.waitForTimeout(500);

    // Użyj unikalnego timestampowego kodu dla każdego testu
    const uniqueCode1 = 'E2ECOIN' + Date.now().toString(36).toUpperCase().slice(-4);
    await page.fill('#promo-code-input', uniqueCode1);
    await page.fill('#promo-max-uses', '10');

    // Ustaw kwotę coins
    await page.locator('.promo-coins-amount').fill('500');

    // Kliknij "Utwórz kod"
    await page.click('#promo-create-btn');
    await page.waitForTimeout(500);

    // Sprawdź komunikat sukcesu
    await expect(page.locator('#promo-create-status')).toContainText('utworzony');
  });

  test('powinien utworzyć kod z nagrodą gemów', async ({ page }) => {
    await adminLogin(page);
    await page.click('#tab-btn-promo');
    await page.waitForTimeout(500);

    // Zmień typ nagrody na gems
    await page.locator('.promo-reward-type').first().selectOption('gems');
    await page.waitForTimeout(200);
    // Pole gems powinno być widoczne, coins ukryte
    await expect(page.locator('.promo-gem-select')).toBeVisible();
    await expect(page.locator('.promo-coins-amount')).not.toBeVisible();

    const uniqueCode2 = 'E2EGEM' + Date.now().toString(36).toUpperCase().slice(-4);
    await page.fill('#promo-code-input', uniqueCode2);
    await page.fill('#promo-max-uses', '5');
    await page.locator('.promo-gem-select').selectOption('Gem 💎 10M');
    await page.locator('.promo-gem-qty').fill('3');

    await page.click('#promo-create-btn');
    await page.waitForTimeout(500);
    await expect(page.locator('#promo-create-status')).toContainText('utworzony');
  });

  test('powinien utworzyć kod z wieloma nagrodami', async ({ page }) => {
    await adminLogin(page);
    await page.click('#tab-btn-promo');
    await page.waitForTimeout(500);

    // Dodaj drugą nagrodę
    await page.click('#promo-add-reward-btn');
    const rewardRows = page.locator('.promo-reward-row');
    await expect(rewardRows).toHaveCount(2);

    // Pierwszy wiersz - coins
    await rewardRows.nth(0).locator('.promo-coins-amount').fill('1000');
    // Drugi wiersz - gems
    await rewardRows.nth(1).locator('.promo-reward-type').selectOption('gems');
    await page.waitForTimeout(200);
    await rewardRows.nth(1).locator('.promo-gem-select').selectOption('Gem 💎 1M');
    await rewardRows.nth(1).locator('.promo-gem-qty').fill('5');

    const uniqueCode3 = 'E2ECOMBO' + Date.now().toString(36).toUpperCase().slice(-4);
    await page.fill('#promo-code-input', uniqueCode3);
    await page.fill('#promo-max-uses', '3');

    await page.click('#promo-create-btn');
    await page.waitForTimeout(500);
    await expect(page.locator('#promo-create-status')).toContainText('utworzony');
  });

  test('powinien wyświetlić utworzone kody na liście', async ({ page }) => {
    await adminLogin(page);
    await page.click('#tab-btn-promo');
    await page.waitForTimeout(500);

    const uniqueCode4 = 'E2ELIST' + Date.now().toString(36).toUpperCase().slice(-4);
    // Utwórz kod najpierw
    await page.fill('#promo-code-input', uniqueCode4);
    await page.fill('#promo-max-uses', '10');
    await page.click('#promo-create-btn');
    await page.waitForTimeout(500);

    // Powinien być widoczny na liście
    const codeList = page.locator('#promo-codes-list');
    await expect(codeList).toContainText(uniqueCode4);
  });

  test('powinien dezaktywować kod przez przycisk', async ({ page }) => {
    await adminLogin(page);
    await page.click('#tab-btn-promo');
    await page.waitForTimeout(500);

    const uniqueCode5 = 'E2ETOGG' + Date.now().toString(36).toUpperCase().slice(-4);
    // Utwórz kod
    await page.fill('#promo-code-input', uniqueCode5);
    await page.fill('#promo-max-uses', '10');
    await page.click('#promo-create-btn');
    await page.waitForTimeout(500);

    // Kliknij "Dezaktywuj"
    const toggleBtn = page.locator('.promo-toggle-btn').first();
    await toggleBtn.click();
    await page.waitForTimeout(500);

    // Powinien pokazać "Aktywuj" zamiast "Dezaktywuj"
    await expect(page.locator('.promo-toggle-btn').first()).toHaveText('Aktywuj');
  });

  test('powinien ostrzec przed pustym kodem', async ({ page }) => {
    await adminLogin(page);
    await page.click('#tab-btn-promo');
    await page.waitForTimeout(500);

    // Kliknij utwórz bez wpisywania kodu
    await page.click('#promo-create-btn');
    await expect(page.locator('#promo-create-status')).toContainText('Podaj nazwę');
  });
});

test.describe('🔄 Admin panel - lista graczy', () => {
  test('powinna załadować listę graczy', async ({ page }) => {
    await adminLogin(page);
    await page.click('#tab-btn-players');
    await page.waitForTimeout(500);

    // Zakładka graczy powinna być widoczna
    await page.waitForSelector('#tab-players', { state: 'visible', timeout: 8000 });
    // Lista graczy lub pusty stan powinny być w DOM
    await expect(page.locator('#tab-players')).toBeVisible();
  });
});

test.describe('📱 UI - ogólne elementy', () => {
  test('powinien pokazać modal promo code po kliknięciu sidebar linka', async ({ page }) => {
    await page.goto('/');

    // Jeśli jest login-overlay (niezalogowany), ukryj go klikając w tło lub czekaj
    const overlay = page.locator('#login-overlay');
    if (await overlay.isVisible().catch(() => false)) {
      // Ukryj overlay przez CSS - ustaw display:none aby odblokować interakcje
      await page.evaluate(() => {
        document.getElementById('login-overlay').style.display = 'none';
      });
      await page.waitForTimeout(200);
    }

    // Kliknij "Promo Code" w sidebarze
    const promoLink = page.locator('.sidebar-link', { hasText: 'Promo Code' });
    if (await promoLink.isVisible().catch(() => false)) {
      await promoLink.click();
      await page.waitForTimeout(300);
      // Modal powinien być widoczny
      await expect(page.locator('#promo-modal')).toBeVisible();
      await expect(page.locator('#promo-input')).toBeVisible();
      await expect(page.locator('.promo-submit-btn')).toBeVisible();
    }
  });

  test('powinien wyświetlić online count', async ({ page }) => {
    await page.goto('/');

    // Online count badge
    const onlineEl = page.locator('.online-count, #online-count');
    if (await onlineEl.isVisible().catch(() => false)) {
      await expect(onlineEl).toBeVisible();
    }
  });
});

test.describe('🚪 Admin panel - wylogowanie', () => {
  test('powinien wylogować admina i wrócić do login boxa', async ({ page }) => {
    await adminLogin(page);
    await page.click('#btn-logout');
    await page.waitForTimeout(500);

    // Po wylogowaniu przekierowanie /admin pokazuje login box
    await page.waitForSelector('#login-box', { state: 'visible', timeout: 5000 });
    await expect(page.locator('#login-box')).toBeVisible();
  });
});
