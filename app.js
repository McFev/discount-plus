const APP_VERSION = "1.0.1";

// ===== Хранилища =====
// Настройки (категории и фильтры) хранятся в localStorage под ключом
// в формате JSON: { "categories": [...], "filters": { "favorites": bool, "category": "" } }
const STORAGE_KEY = 'discountPlus';
// Карты хранятся в IndexedDB
const DB_NAME = 'discountPlus';
const DB_VERSION = 1;
const CARDS_STORE = 'cards';

// ===== Работа с IndexedDB (хранилище карт) =====
const CardsDB = {
    _db: null,

    // Открытие (или создание) базы данных
    open() {
        if (this._db) return Promise.resolve(this._db);
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = event => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(CARDS_STORE)) {
                    db.createObjectStore(CARDS_STORE, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => {
                this._db = request.result;
                resolve(this._db);
            };
            request.onerror = () => reject(request.error);
        });
    },

    // Все карты из хранилища
    getAll() {
        return this.open().then(db => new Promise((resolve, reject) => {
            const request = db.transaction(CARDS_STORE, 'readonly')
                .objectStore(CARDS_STORE)
                .getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        }));
    },

    // Полная замена содержимого хранилища (одна транзакция)
    replaceAll(cards) {
        return this.open().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(CARDS_STORE, 'readwrite');
            const store = tx.objectStore(CARDS_STORE);
            store.clear();
            (cards || []).forEach(card => store.put(card));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        }));
    }
};

// Управление картами лояльности
class LoyaltyCardsApp {
    constructor() {
        this.cards = [];
        this.categories = [];
        this.currentEditingId = null;
        this.modalStack = []; // Стек открытых модалок в порядке открытия (для закрытия по ESC)
        this._dialogResolver = null; // Резолвер Promise текущего диалога (замена alert/confirm)
        this.searchQuery = '';
        this.filterFavorites = false;
        this.filterCategory = '';
        this.init().catch(err => console.error('Ошибка инициализации приложения:', err));
    }

    async init() {
        // Сначала вешаем обработчики, чтобы интерфейс отвечал сразу
        this.setupEventListeners();

        // Категории и фильтры — из localStorage (ключ discountPlus)
        this.loadSettings();

        // Карты — из IndexedDB (при первом запуске мигрируют из localStorage)
        this.cards = await this.loadCards();

        this.updateCategorySelects();
        this.updateCategoryFilters();
        this.applyFilters();
        this.renderCards();
        this.registerServiceWorker();
    }

    // Универсальная SVG-иконка звезды с разными цветами через классы
    getStarSvg(isActive, extraClass = '') {
        const baseClass = 'star-icon';
        const activeClass = isActive ? 'star-icon--active' : 'star-icon--inactive';
        const classes = [baseClass, activeClass, extraClass].filter(Boolean).join(' ');

        return `
            <svg class="${classes}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"></path>
            </svg>
        `;
    }

    // Обновление списков категорий в селектах
    updateCategorySelects() {
        const cardCategorySelect = document.getElementById('cardCategory');

        // Обновляем селект в форме
        const currentCardCategory = cardCategorySelect.value;
        cardCategorySelect.innerHTML = '<option value="">Без категории</option>';
        this.categories.forEach(cat => {
            const option = document.createElement('option');
            option.value = cat;
            option.textContent = cat;
            cardCategorySelect.appendChild(option);
        });
        if (currentCardCategory) {
            cardCategorySelect.value = currentCardCategory;
        }
    }

    // Обновление кнопок фильтров категорий
    updateCategoryFilters() {
        const categoryFilters = document.getElementById('categoryFilters');
        categoryFilters.querySelectorAll('*:not([id])').forEach(el => el.remove());

        this.categories.forEach(cat => {
            const btn = document.createElement('button');
            btn.className = 'btn btn-filter';
            btn.textContent = cat;
            btn.dataset.filter = cat;
            btn.addEventListener('click', () => {
                this.filterCategory = cat;
                this.filterFavorites = false;
                this.saveSettings();
                this.updateFilterButtons(cat);
                this.renderCards();
            });
            categoryFilters.appendChild(btn);
        });
    }

    // Обновление активного состояния кнопок фильтров
    updateFilterButtons(activeFilter) {
        document.querySelectorAll('.btn-filter').forEach(btn => {
            btn.classList.remove('active');
        });

        if (activeFilter === '') {
            document.getElementById('filterAll').classList.add('active');
        } else if (activeFilter === 'favorites') {
            document.getElementById('filterFavorites').classList.add('active');
        } else {
            const btn = document.querySelector(`.btn-filter[data-filter="${activeFilter}"]`);
            if (btn) btn.classList.add('active');
        }
    }

    // ===== Карты (IndexedDB) =====

    // Загрузка карт из IndexedDB (с разовой миграцией из localStorage)
    async loadCards() {
        try {
            return await CardsDB.getAll();
        } catch (err) {
            console.error('Ошибка загрузки карт из IndexedDB:', err);
            return [];
        }
    }

    // Сохранение карт в IndexedDB
    saveCards() {
        return CardsDB.replaceAll(this.cards).catch(err => {
            console.error('Ошибка сохранения карт в IndexedDB:', err);
        });
    }

    // ===== Настройки (localStorage, ключ discountPlus) =====

    // Загрузка категорий и фильтров из localStorage
    loadSettings() {
        this.categories = [];
        this.filterFavorites = false;
        this.filterCategory = '';
        this.importUrl = '';

        let settings = null;
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                settings = JSON.parse(stored);
            }
        } catch (err) {
            console.error('Ошибка чтения настроек из localStorage:', err);
        }

        if (settings) {
            if (Array.isArray(settings.categories)) {
                this.categories = settings.categories;
            }
            if (settings.filters && typeof settings.filters === 'object') {
                this.filterFavorites = settings.filters.favorites === true;
                if (typeof settings.filters.category === 'string') {
                    this.filterCategory = settings.filters.category;
                }
            }
            // Адрес последней загрузки по URL (подставляется в форму импорта)
            if (typeof settings.importUrl === 'string') {
                this.importUrl = settings.importUrl;
            }
        }
    }

    // Сохранение категорий и фильтров в localStorage
    saveSettings() {
        const settings = {
            categories: this.categories,
            filters: {
                favorites: this.filterFavorites,
                category: this.filterCategory
            },
            // Адрес последней загрузки по URL (для формы импорта)
            importUrl: this.importUrl || ''
        };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (err) {
            console.error('Ошибка сохранения настроек в localStorage:', err);
        }
    }

    // Применение сохраненных фильтров к UI
    applyFilters() {
        if (this.filterFavorites) {
            this.updateFilterButtons('favorites');
        } else if (this.filterCategory) {
            this.updateFilterButtons(this.filterCategory);
        } else {
            this.updateFilterButtons('');
        }
    }

    // Транслитерация текста
    transliterate(text) {
        const translitMap = {
            'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
            'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
            'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
            'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
            'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
            'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'Yo',
            'Ж': 'Zh', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M',
            'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U',
            'Ф': 'F', 'Х': 'H', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Sch',
            'Ъ': '', 'Ы': 'Y', 'Ь': '', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya'
        };
        return text.split('').map(char => translitMap[char] || char).join('');
    }

    // Проверка, содержит ли текст английские буквы
    hasEnglishLetters(text) {
        return /[a-zA-Z]/.test(text);
    }

    // Вычисление яркости цвета (для определения контрастного текста)
    getLuminance(hex) {
        const rgb = this.hexToRgb(hex);
        if (!rgb) return 0;
        const [r, g, b] = [rgb.r, rgb.g, rgb.b].map(val => {
            val = val / 255;
            return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    // Конвертация hex в RGB
    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    }

    // Определение контрастного цвета текста (черный или белый)
    getContrastColor(hex) {
        const luminance = this.getLuminance(hex);
        return luminance > 0.5 ? '#000000' : '#ffffff';
    }

    // Регистрация Service Worker
    registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./service-worker.js')
                    .then(registration => {
                        console.log('Service Worker зарегистрирован:', registration);
                    })
                    .catch(error => {
                        console.log('Ошибка регистрации Service Worker:', error);
                    });
            });
        }
    }

    // Соответствие типа модалки в history.state и её DOM-элемента
    modalIdByType() {
        return {
            card: 'cardModal',
            detail: 'cardDetailModal',
            about: 'aboutModal',
            category: 'categoryModal',
            data: 'dataModal',
            dialog: 'dialogModal'
        };
    }

    // === УНИВЕРСАЛЬНАЯ обработка кнопки "Назад" ===
    setupBackButtonHandling() {
        const modalIdByType = this.modalIdByType();

        window.addEventListener('popstate', (e) => {
            const state = e.state || null;

            // Модалка, соответствующая текущей записи истории, — её НЕ закрываем
            // (например, форма карты остаётся открытой под модалкой категории)
            const keepId = state && state.modal ? modalIdByType[state.modal] : null;

            // Кроме текущей модалки оставляем открытыми и всё, что открыто ПОД ней
            // в стеке: например, при закрытии диалога поверх окна категории форма
            // карты, открытая под категорией, обязана остаться на экране
            const keepIndex = keepId ? this.modalStack.indexOf(keepId) : -1;
            const keepIds = keepId
                ? this.modalStack.slice(0, keepIndex === -1 ? this.modalStack.length : keepIndex + 1)
                : [];
            if (keepId && !keepIds.includes(keepId)) {
                keepIds.push(keepId);
            }

            Object.values(modalIdByType).forEach(id => {
                const modal = document.getElementById(id);
                if (modal && modal.classList.contains('show') && !keepIds.includes(id)) {
                    modal.classList.remove('show');

                    // Синхронизируем стек открытых модалок
                    this.modalStack = this.modalStack.filter(openId => openId !== id);

                    // Диалог, закрытый кнопкой «Назад», считается отменённым
                    if (id === 'dialogModal') {
                        this._resolveDialog(false);
                    }

                    if (id === 'cardModal') {
                        // Сброс состояния формы добавления/редактирования
                        this.currentEditingId = null;
                        document.getElementById('cardForm')?.reset();
                        document.getElementById('cardColor').value = '#9b68cd';
                        document.getElementById('translitGroup').style.display = 'none';
                        const logoPreview = document.getElementById('logoPreview');
                        if (logoPreview) {
                            logoPreview.innerHTML = '';
                            logoPreview.dataset.logoRemoved = 'false';
                        }
                        document.getElementById('removeLogoBtn').style.display = 'none';
                    }

                    if (id === 'categoryModal') {
                        document.getElementById('categoryForm')?.reset();
                    }
                }
            });

            // Полностью очищаем URL от «мусорного» хэша, сохраняя состояние записи
            if (window.location.hash) {
                history.replaceState(state, '', window.location.pathname);
            }
        });

        // После перезагрузки страницы все модалки закрыты — очищаем «зависшее»
        // состояние записи, чтобы кнопка "Назад" не делала лишний холостой шаг
        if (history.state && (history.state.modal || history.state.modalOpen)) {
            history.replaceState(null, '', window.location.pathname);
        }
    }

    // Регистрация модалки в истории браузера (для закрытия по кнопке "Назад")
    pushModalState(type, extraState = {}) {
        const state = { modal: type, ...extraState };
        const modalId = this.modalIdByType()[type];

        // Запоминаем порядок открытия модалок, чтобы ESC закрывал их сверху вниз
        if (!this.modalStack.includes(modalId)) {
            this.modalStack.push(modalId);
        }

        // Переход «просмотр карты → редактирование»: просмотр закрывается сразу
        // после открытия формы, поэтому заменяем запись истории, а не добавляем
        // новую — иначе в истории остаётся лишний шаг
        const isDetailToEdit = type === 'card' &&
            document.getElementById('cardDetailModal')?.classList.contains('show');

        if (isDetailToEdit) {
            history.replaceState(state, '', window.location.pathname);
        } else {
            history.pushState(state, '', window.location.pathname);
        }
    }

    // Удаление записи модалки из истории при закрытии самим приложением
    // (по крестику, "Отмене", ESC или клику мимо модалки)
    popModalState(type) {
        const modalId = this.modalIdByType()[type];
        // Убираем модалку из стека открытых
        this.modalStack = this.modalStack.filter(id => id !== modalId);

        if (history.state && history.state.modal === type) {
            history.back();
        }
    }

    // === Диалоговые окна вместо alert/confirm ===

    // Показ диалога. Возвращает Promise<boolean>: true — нажата кнопка подтверждения,
    // false — «Отмена», крестик, ESC, клик мимо или кнопка «Назад».
    showDialog({ title = 'Внимание', message, okText = 'ОК', cancelText = null, danger = false }) {
        return new Promise(resolve => {
            const modal = document.getElementById('dialogModal');
            document.getElementById('dialogTitle').textContent = title;
            document.getElementById('dialogMessage').textContent = message;

            const okBtn = document.getElementById('dialogOkBtn');
            const cancelBtn = document.getElementById('dialogCancelBtn');

            okBtn.textContent = okText;
            okBtn.classList.toggle('btn-danger', !!danger);
            okBtn.classList.toggle('btn-primary', !danger);

            cancelBtn.textContent = cancelText || 'Отмена';
            cancelBtn.style.display = cancelText ? 'inline-block' : 'none';

            this._dialogResolver = resolve;
            modal.classList.add('show');

            // Диалог участвует в общей системе модалок: «Назад» и ESC закрывают
            // именно его, не трогая открытые под ним модалки
            this.pushModalState('dialog');
        });
    }

    // Информационное окно (замена alert)
    showAlert(message, title = 'Внимание') {
        return this.showDialog({ title, message });
    }

    // Окно подтверждения (замена confirm)
    showConfirm(message, { title = 'Подтверждение', okText = 'Да', cancelText = 'Отмена', danger = false } = {}) {
        return this.showDialog({ title, message, okText, cancelText, danger });
    }

    // Закрытие диалога с результатом (true — подтверждение, false — отмена)
    closeDialog(result = false) {
        const modal = document.getElementById('dialogModal');
        if (modal && modal.classList.contains('show')) {
            modal.classList.remove('show');
            this.popModalState('dialog');
            this._resolveDialog(result);
        }
    }

    // Разовый вызов отложенного резолвера диалога
    _resolveDialog(result) {
        if (this._dialogResolver) {
            const resolve = this._dialogResolver;
            this._dialogResolver = null;
            resolve(result);
        }
    }

    setupEventListeners() {
        const addCardBtn = document.getElementById('addCardBtn');
        const closeBtn = document.querySelector('#cardModal .close');
        const cancelBtn = document.getElementById('cancelBtn');
        const cardForm = document.getElementById('cardForm');
        const cardLogoInput = document.getElementById('cardLogo');
        const removeLogoBtn = document.getElementById('removeLogoBtn');
        const closeDetailModal = document.getElementById('closeDetailModal');
        const searchInput = document.getElementById('searchInput');
        const filterAll = document.getElementById('filterAll');
        const filterFavorites = document.getElementById('filterFavorites');
        const aboutBtn = document.getElementById('aboutBtn');
        const closeAboutModal = document.getElementById('closeAboutModal');
        const addCategoryBtn = document.getElementById('addCategoryBtn');
        const categoryForm = document.getElementById('categoryForm');
        const closeCategoryModal = document.getElementById('closeCategoryModal');
        const cancelCategoryBtn = document.getElementById('cancelCategoryBtn');
        const openDataModalBtn = document.getElementById('openDataModalBtn');
        const closeDataModal = document.getElementById('closeDataModal');
        const exportBtn = document.getElementById('exportBtn');
        const importFileInput = document.getElementById('importFile');
        const importUrlBtn = document.getElementById('importUrlBtn');
        const closeDialogModal = document.getElementById('closeDialogModal');
        const dialogOkBtn = document.getElementById('dialogOkBtn');
        const dialogCancelBtn = document.getElementById('dialogCancelBtn');
        const cardNameInput = document.getElementById('cardName');

        // Открытие/закрытие модалок
        addCardBtn.addEventListener('click', e => { e.preventDefault(); this.openModal(); });
        closeBtn.addEventListener('click', () => this.closeModal());
        cancelBtn.addEventListener('click', () => this.closeModal());
        closeDetailModal.addEventListener('click', () => this.closeDetailModal());
        aboutBtn.addEventListener('click', e => { e.preventDefault(); this.openAboutModal(); });
        closeAboutModal.addEventListener('click', () => this.closeAboutModal());
        addCategoryBtn.addEventListener('click', e => { e.preventDefault(); this.openCategoryModal(); });
        closeCategoryModal.addEventListener('click', () => this.closeCategoryModal());
        cancelCategoryBtn.addEventListener('click', () => this.closeCategoryModal());

        // Экспорт и импорт карт (кнопка в окне "О программе")
        openDataModalBtn.addEventListener('click', () => this.openDataModal());
        closeDataModal.addEventListener('click', () => this.closeDataModal());
        exportBtn.addEventListener('click', () => this.exportCards());
        importFileInput.addEventListener('change', e => this.handleImportFile(e));
        importUrlBtn.addEventListener('click', () => this.handleImportUrl());

        // Диалоговые окна (замена alert/confirm)
        closeDialogModal.addEventListener('click', () => this.closeDialog(false));
        dialogOkBtn.addEventListener('click', () => this.closeDialog(true));
        dialogCancelBtn.addEventListener('click', () => this.closeDialog(false));

        // Клик вне модалки (по затемнению) — закрываем штатным методом,
        // чтобы запись модалки была удалена из истории
        window.addEventListener('click', e => {
            if (e.target.classList.contains('modal')) {
                if (e.target.id === 'cardModal') this.closeModal();
                else if (e.target.id === 'cardDetailModal') this.closeDetailModal();
                else if (e.target.id === 'aboutModal') this.closeAboutModal();
                else if (e.target.id === 'categoryModal') this.closeCategoryModal();
                else if (e.target.id === 'dataModal') this.closeDataModal();
                else if (e.target.id === 'dialogModal') this.closeDialog(false);
                else e.target.classList.remove('show');
            }
        });

        // Формы
        cardForm.addEventListener('submit', e => { e.preventDefault(); this.saveCard(); });
        categoryForm.addEventListener('submit', e => { e.preventDefault(); this.addCategory(); });

        // Логотип
        cardLogoInput.addEventListener('change', e => this.handleLogoUpload(e));
        removeLogoBtn.addEventListener('click', () => this.removeLogoPreview());

        // Поиск
        searchInput.addEventListener('input', e => {
            this.searchQuery = e.target.value.toLowerCase();
            this.renderCards();
        });

        // Фильтры
        filterAll.addEventListener('click', () => {
            this.filterFavorites = false;
            this.filterCategory = '';
            this.saveSettings();
            this.updateFilterButtons('');
            this.renderCards();
        });

        filterFavorites.addEventListener('click', () => {
            this.filterFavorites = true;
            this.filterCategory = '';
            this.saveSettings();
            this.updateFilterButtons('favorites');
            this.renderCards();
        });

        // Автотранслит
        cardNameInput.addEventListener('input', e => {
            const name = e.target.value;
            const translitGroup = document.getElementById('translitGroup');
            const translitInput = document.getElementById('cardTranslit');

            if (this.hasEnglishLetters(name)) {
                translitGroup.style.display = 'block';
                if (!translitInput.value || translitInput.dataset.autoGenerated === 'true') {
                    translitInput.value = this.transliterate(name);
                    translitInput.dataset.autoGenerated = 'true';
                }
            } else {
                translitGroup.style.display = 'none';
                if (translitInput.dataset.autoGenerated === 'true') {
                    translitInput.value = '';
                }
            }
        });

        // ESC — закрываем верхнюю (последнюю открытую) модалку штатным методом,
        // чтобы её запись была удалена из истории
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                const shownModals = document.querySelectorAll('.modal.show');
                if (!shownModals.length) return;

                // Верхняя модалка — последняя открытая (из стека);
                // если стек разошёлся с DOM — берём последнюю открытую в DOM
                const topId = this.modalStack[this.modalStack.length - 1];
                const topEl = topId ? document.getElementById(topId) : null;
                const openModalEl = topEl && topEl.classList.contains('show')
                    ? topEl
                    : shownModals[shownModals.length - 1];

                if (openModalEl.id === 'cardModal') this.closeModal();
                else if (openModalEl.id === 'cardDetailModal') this.closeDetailModal();
                else if (openModalEl.id === 'aboutModal') this.closeAboutModal();
                else if (openModalEl.id === 'categoryModal') this.closeCategoryModal();
                else if (openModalEl.id === 'dataModal') this.closeDataModal();
                else if (openModalEl.id === 'dialogModal') this.closeDialog(false);
                else openModalEl.classList.remove('show');
            }
        });

        // Кнопка "Назад" — универсальная
        this.setupBackButtonHandling();
    }

    // Открытие модального окна
    openModal(cardId = null) {
        const modal = document.getElementById('cardModal');
        const modalTitle = document.getElementById('modalTitle');
        const form = document.getElementById('cardForm');
        const logoPreview = document.getElementById('logoPreview');
        const removeLogoBtn = document.getElementById('removeLogoBtn');

        this.currentEditingId = cardId;

        if (cardId) {
            // Редактирование существующей карты
            const card = this.cards.find(c => c.id === cardId);
            if (card) {
                modalTitle.textContent = 'Редактировать карту';
                document.getElementById('cardName').value = card.name;
                document.getElementById('cardTranslit').value = card.translit || '';
                document.getElementById('cardCategory').value = card.category || '';
                document.getElementById('cardColor').value = card.color || '#9b68cd';
                document.getElementById('barcodeType').value = card.barcodeType;
                document.getElementById('barcodeValue').value = card.barcodeValue;
                document.getElementById('additionalInfo').value = card.additionalInfo || '';

                // Показываем/скрываем поле транслита
                const translitGroup = document.getElementById('translitGroup');
                if (card.translit || this.hasEnglishLetters(card.name)) {
                    translitGroup.style.display = 'block';
                } else {
                    translitGroup.style.display = 'none';
                }

                // Показываем логотип если есть
                if (card.logo) {
                    logoPreview.innerHTML = `<img src="${card.logo}" alt="Логотип">`;
                    logoPreview.dataset.logoRemoved = 'false';
                    removeLogoBtn.style.display = 'block';
                } else {
                    logoPreview.innerHTML = '';
                    logoPreview.dataset.logoRemoved = 'false';
                    removeLogoBtn.style.display = 'none';
                }
            }
        } else {
            // Добавление новой карты
            modalTitle.textContent = 'Добавить карту';
            form.reset();
            document.getElementById('cardColor').value = '#9b68cd';
            document.getElementById('translitGroup').style.display = 'none';
            logoPreview.innerHTML = '';
            logoPreview.dataset.logoRemoved = 'false';
            removeLogoBtn.style.display = 'none';
        }

        modal.classList.add('show');
        this.pushModalState('card');
    }

    // Закрытие модального окна
    closeModal() {  // это модалка добавления/редактирования
        const modal = document.getElementById('cardModal');
        if (modal && modal.classList.contains('show')) {
            modal.classList.remove('show');
            this.currentEditingId = null;
            document.getElementById('cardForm').reset();
            document.getElementById('cardColor').value = '#9b68cd';
            document.getElementById('translitGroup').style.display = 'none';
            document.getElementById('logoPreview').innerHTML = '';
            document.getElementById('removeLogoBtn').style.display = 'none';

            // Убираем запись модалки из истории
            this.popModalState('card');
        }
    }

    // Обработка загрузки логотипа
    async handleLogoUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            await this.showAlert('Пожалуйста, выберите изображение', 'Неверный формат файла');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const logoPreview = document.getElementById('logoPreview');
            logoPreview.innerHTML = `<img src="${e.target.result}" alt="Логотип">`;
            logoPreview.dataset.logoRemoved = 'false'; // Сбрасываем флаг удаления
            document.getElementById('removeLogoBtn').style.display = 'block';
        };
        reader.readAsDataURL(file);
    }

    // Удаление превью логотипа
    removeLogoPreview() {
        document.getElementById('logoPreview').innerHTML = '';
        document.getElementById('cardLogo').value = '';
        document.getElementById('removeLogoBtn').style.display = 'none';
        // Сохраняем флаг удаления логотипа
        document.getElementById('logoPreview').dataset.logoRemoved = 'true';
    }

    // Открытие детального просмотра карты
    openCardDetail(cardId) {
        const card = this.cards.find(c => c.id === cardId);
        if (!card) return;

        const modal = document.getElementById('cardDetailModal');
        const content = document.getElementById('cardDetailContent');
        const title = document.getElementById('detailCardTitle');

        title.textContent = card.name;

        let logoHtml = '';
        /*if (card.logo) {
            logoHtml = `<img src="${card.logo}" alt="Логотип" class="card-detail-logo">`;
        } else {
            logoHtml = `<div class="card-detail-logo-placeholder">
                <svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="500" height="500" viewBox="0 0 132.292 132.292">
                    <g transform="matrix(.80527 0 0 .80527 -9.083 -109.643)">
                        <path d="M178.509 97.39c-1.53 1.055-5.349 14.91-7.166 15.299s-10.969-10.693-12.796-11.03c-1.828-.336-14.325 6.761-15.885 5.75-1.56-1.01-.195-15.316-1.25-16.846s-14.909-5.349-15.298-7.166 10.693-10.969 11.03-12.796c.336-1.828-6.761-14.325-5.751-15.885s15.317-.195 16.847-1.25 5.349-14.909 7.166-15.297c1.817-.39 10.969 10.692 12.796 11.028 1.828.337 14.325-6.76 15.885-5.75s.195 15.317 1.25 16.847 14.909 5.349 15.297 7.166c.389 1.817-10.692 10.969-11.028 12.796-.337 1.828 6.76 14.325 5.75 15.885s-15.317.195-16.847 1.25z" style="fill:none;stroke:currentColor;stroke-width:3.99;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-opacity:1;paint-order:stroke fill markers" transform="rotate(-8.888 1303.25 253.662)scale(.83658)"/>
                        <path d="M87.165 244.172H39.986a3.884 3.884 0 0 1-3.902-3.883V179.77a3.884 3.884 0 0 1 3.902-3.884v0h99.17a3.884 3.884 0 0 1 3.903 3.884v42.246" style="fill:none;stroke:currentColor;stroke-width:3.98097;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-opacity:1;paint-order:stroke fill markers"/>
                        <path d="M36.739 187.108h105.34M36.251 199.788h105.665" style="fill-opacity:.563749;stroke:currentColor;stroke-width:3.99;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-opacity:1;paint-order:stroke fill markers"/>
                        <path d="M45.03 214.581h38.364" style="fill-opacity:.563749;stroke:currentColor;stroke-width:3.99;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-opacity:1;paint-order:stroke fill markers" transform="translate(-.035)"/>
                        <path d="M45.03 214.581h38.364" style="fill-opacity:.563749;stroke:currentColor;stroke-width:3.99;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-opacity:1;paint-order:stroke fill markers" transform="translate(-.035 12.984)"/>
                        <circle cx="113.285" cy="237.685" r="5.446" style="fill:none;fill-opacity:.563749;stroke:currentColor;stroke-width:3.59;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-dasharray:none;stroke-opacity:1;paint-order:stroke fill markers"/>
                        <circle cx="129.899" cy="254.394" r="5.446" style="fill:none;fill-opacity:.563749;stroke:currentColor;stroke-width:3.59;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-dasharray:none;stroke-opacity:1;paint-order:stroke fill markers"/>
                        <path d="m111.069 256.651 20.92-20.95" style="fill:none;fill-opacity:.563749;stroke:currentColor;stroke-width:3.59;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-dasharray:none;stroke-opacity:1;paint-order:stroke fill markers"/>
                    </g>
                </svg>
            </div>`;
        }*/

        const favoriteClass = card.favorite ? 'active' : '';
        const categoryText = card.category ? `<div class="card-info-item">
                    <span class="card-info-label">Категория:</span>
                    <span class="card-info-value">${this.escapeHtml(card.category)}</span>
                </div>` : '';
        const translitText = card.translit ? `<div class="card-info-item">
                    <span class="card-info-label">Транслит:</span>
                    <span class="card-info-value">${this.escapeHtml(card.translit)}</span>
                </div>` : '';

        content.innerHTML = `
            <div style="text-align: right; margin-bottom: 10px;">
                <button class="card-favorite-btn ${favoriteClass}" data-card-id="${card.id}" style="position: static; font-size: 28px;">
                    ${this.getStarSvg(card.favorite, 'star-icon--large')}
                </button>
            </div>
            ${logoHtml}
            <div class="card-barcode" id="detail-barcode-${card.id}"></div>
            <div class="card-info">
                <!--<div class="card-info-item">
                    <span class="card-info-label">Название:</span>
                    <span class="card-info-value">${this.escapeHtml(card.name)}</span>
                </div>-->
                <!--${translitText}-->
                ${categoryText}
                <!--<div class="card-info-item">
                    <span class="card-info-label">Цвет:</span>
                    <span class="card-info-value">
                        <span style="display: inline-block; width: 20px; height: 20px; background: ${card.color || '#9b68cd'}; border-radius: 4px; vertical-align: middle; margin-right: 5px;"></span>
                        ${card.color || '#9b68cd'}
                    </span>
                </div>-->
                <!--<div class="card-info-item">
                    <span class="card-info-label">Тип штрих-кода:</span>
                    <span class="card-info-value">${this.escapeHtml(card.barcodeType)}</span>
                </div>-->
                <div class="card-info-item">
                    <span class="card-info-label">Штрих-код:</span>
                    <span class="card-info-value">${this.escapeHtml(card.barcodeValue)}</span>
                </div>
                ${card.additionalInfo ? card.additionalInfo
                .split('\n')
                .filter(Boolean)
                .map(line => {
                    const match = line.match(/^\*(.+?)\*:\s*(.*)$/);
                    const label = match ? match[1] : 'Доп. информация';
                    const value = match ? match[2] : line;
                    return `
                        <div class="card-info-item">
                            <span class="card-info-label">${this.escapeHtml(label)}:</span>
                            <span class="card-info-value">${this.escapeHtml(value)}</span>
                        </div>
                    `;
                })
                .join('')
                : ''}
            </div>
            <div class="form-actions" style="margin-top: 20px;">
                <button class="btn btn-edit" data-action="edit" data-card-id="${card.id}">Редактировать</button>
                <button class="btn btn-danger" data-action="delete" data-card-id="${card.id}">Удалить</button>
            </div>
        `;

        modal.classList.add('show');
        this.pushModalState('detail', { cardId });

        // Обработчик клика по кнопке избранного в детальном просмотре
        const detailFavoriteBtn = content.querySelector('.card-favorite-btn');
        if (detailFavoriteBtn) {
            detailFavoriteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleFavorite(card.id);
            });
        }

        // Обработчики для кнопок редактирования и удаления
        const editBtn = content.querySelector('[data-action="edit"]');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                this.openModal(card.id);
                this.closeDetailModal();
            });
        }

        const deleteBtn = content.querySelector('[data-action="delete"]');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                this.deleteCard(card.id);
            });
        }

        // Генерация штрих-кода
        setTimeout(() => {
            this.generateBarcode(`detail-barcode-${card.id}`, card.barcodeValue, card.barcodeType);
        }, 100);
    }

    // Закрытие детального просмотра
    closeDetailModal() {
        const modal = document.getElementById('cardDetailModal');
        if (modal && modal.classList.contains('show')) {
            modal.classList.remove('show');

            // Убираем запись модалки из истории
            this.popModalState('detail');
        }
    }

    // Сохранение карты
    async saveCard() {
        const name = document.getElementById('cardName').value.trim();
        const translit = document.getElementById('cardTranslit').value.trim();
        const category = document.getElementById('cardCategory').value;
        const color = document.getElementById('cardColor').value;
        const favorite = this.cards.find(c => c.id === this.currentEditingId)?.favorite || false;
        const barcodeType = document.getElementById('barcodeType').value;
        const barcodeValue = document.getElementById('barcodeValue').value.trim();
        const additionalInfo = document.getElementById('additionalInfo').value.trim();
        const logoPreview = document.getElementById('logoPreview');
        const logoImg = logoPreview.querySelector('img');
        const logoRemoved = logoPreview.dataset.logoRemoved === 'true';

        // Определяем логотип: новый загруженный, старый (при редактировании) или null
        let logo = null;
        if (logoImg) {
            logo = logoImg.src;
        } else if (!logoRemoved && this.currentEditingId) {
            // Сохраняем старый логотип если не удален
            const oldCard = this.cards.find(c => c.id === this.currentEditingId);
            logo = oldCard ? oldCard.logo : null;
        }

        if (!name || !barcodeValue) {
            await this.showAlert('Пожалуйста, заполните все обязательные поля');
            return;
        }

        if (this.currentEditingId) {
            // Обновление существующей карты
            const index = this.cards.findIndex(c => c.id === this.currentEditingId);
            if (index !== -1) {
                this.cards[index] = {
                    ...this.cards[index],
                    name,
                    translit: translit || null,
                    category: category || null,
                    color,
                    favorite,
                    barcodeType,
                    barcodeValue,
                    additionalInfo,
                    logo: logo
                };
            }
        } else {
            // Добавление новой карты
            const newCard = {
                id: Date.now().toString(),
                name,
                translit: translit || null,
                category: category || null,
                color,
                favorite,
                barcodeType,
                barcodeValue,
                additionalInfo,
                logo,
                createdAt: new Date().toISOString()
            };
            this.cards.push(newCard);
        }

        await this.saveCards();
        this.updateCategoryFilters();
        this.renderCards();
        this.closeModal();
    }

    // Удаление карты
    async deleteCard(cardId) {
        const confirmed = await this.showConfirm('Вы уверены, что хотите удалить эту карту?', {
            title: 'Удаление карты',
            okText: 'Удалить',
            danger: true
        });
        if (!confirmed) return;

        this.cards = this.cards.filter(c => c.id !== cardId);
        await this.saveCards();
        this.renderCards();
        this.closeDetailModal();
    }

    // Рендеринг всех карт
    renderCards() {
        const container = document.getElementById('cardsContainer');
        const emptyState = document.getElementById('emptyState');

        // Фильтрация карт
        let filteredCards = this.cards;

        // Фильтр по избранным
        if (this.filterFavorites) {
            filteredCards = filteredCards.filter(card => card.favorite);
        }

        // Фильтр по категории
        if (this.filterCategory) {
            filteredCards = filteredCards.filter(card => card.category === this.filterCategory);
        }

        // Поиск по названию
        if (this.searchQuery) {
            filteredCards = filteredCards.filter(card => {
                const name = card.name.toLowerCase();
                const translit = (card.translit || '').toLowerCase();
                return name.includes(this.searchQuery) || translit.includes(this.searchQuery);
            });
        }

        if (filteredCards.length === 0) {
            container.innerHTML = '';
            emptyState.style.display = 'block';
            emptyState.innerHTML = `
                <p>${this.cards.length === 0 ? 'У вас пока нет карт лояльности' : 'Карты не найдены'}</p>
                <p>${this.cards.length === 0 ? 'Нажмите "+" чтобы начать' : 'Попробуйте изменить фильтры или поисковый запрос'}</p>
            `;
            return;
        }

        emptyState.style.display = 'none';
        container.innerHTML = '';

        filteredCards.forEach(card => {
            const cardElement = this.createCardElement(card);
            container.appendChild(cardElement);
        });
    }

    // Создание элемента карты (компактный вид с логотипом)
    createCardElement(card) {
        const cardDiv = document.createElement('div');
        cardDiv.className = 'card';

        // Устанавливаем цвет фона карточки
        const cardColor = card.color || '#9b68cd';
        cardDiv.style.backgroundColor = cardColor;

        // Определяем контрастный цвет текста
        const textColor = this.getContrastColor(cardColor);
        cardDiv.style.color = textColor;

        let logoHtml = '';
        if (card.logo) {
            logoHtml = `<img src="${card.logo}" alt="${this.escapeHtml(card.name)}" class="card-logo">`;
        } else {
            logoHtml = `<div class="card-logo-placeholder">
                <svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="500" height="500" viewBox="0 0 132.292 132.292">
                    <g transform="matrix(.80527 0 0 .80527 -9.083 -109.643)">
                        <path d="M178.509 97.39c-1.53 1.055-5.349 14.91-7.166 15.299s-10.969-10.693-12.796-11.03c-1.828-.336-14.325 6.761-15.885 5.75-1.56-1.01-.195-15.316-1.25-16.846s-14.909-5.349-15.298-7.166 10.693-10.969 11.03-12.796c.336-1.828-6.761-14.325-5.751-15.885s15.317-.195 16.847-1.25 5.349-14.909 7.166-15.297c1.817-.39 10.969 10.692 12.796 11.028 1.828.337 14.325-6.76 15.885-5.75s.195 15.317 1.25 16.847 14.909 5.349 15.297 7.166c.389 1.817-10.692 10.969-11.028 12.796-.337 1.828 6.76 14.325 5.75 15.885s-15.317.195-16.847 1.25z" style="fill:none;stroke:currentColor;stroke-width:3.99;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-opacity:1;paint-order:stroke fill markers" transform="rotate(-8.888 1303.25 253.662)scale(.83658)"/>
                        <path d="M87.165 244.172H39.986a3.884 3.884 0 0 1-3.902-3.883V179.77a3.884 3.884 0 0 1 3.902-3.884v0h99.17a3.884 3.884 0 0 1 3.903 3.884v42.246" style="fill:none;stroke:currentColor;stroke-width:3.98097;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-opacity:1;paint-order:stroke fill markers"/>
                        <path d="M36.739 187.108h105.34M36.251 199.788h105.665" style="fill-opacity:.563749;stroke:currentColor;stroke-width:3.99;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-opacity:1;paint-order:stroke fill markers"/>
                        <path d="M45.03 214.581h38.364" style="fill-opacity:.563749;stroke:currentColor;stroke-width:3.99;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-opacity:1;paint-order:stroke fill markers" transform="translate(-.035)"/>
                        <path d="M45.03 214.581h38.364" style="fill-opacity:.563749;stroke:currentColor;stroke-width:3.99;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-opacity:1;paint-order:stroke fill markers" transform="translate(-.035 12.984)"/>
                        <circle cx="113.285" cy="237.685" r="5.446" style="fill:none;fill-opacity:.563749;stroke:currentColor;stroke-width:3.59;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-dasharray:none;stroke-opacity:1;paint-order:stroke fill markers"/>
                        <circle cx="129.899" cy="254.394" r="5.446" style="fill:none;fill-opacity:.563749;stroke:currentColor;stroke-width:3.59;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-dasharray:none;stroke-opacity:1;paint-order:stroke fill markers"/>
                        <path d="m111.069 256.651 20.92-20.95" style="fill:none;fill-opacity:.563749;stroke:currentColor;stroke-width:3.59;stroke-linecap:round;stroke-linejoin:bevel;stroke-miterlimit:10;stroke-dasharray:none;stroke-opacity:1;paint-order:stroke fill markers"/>
                    </g>
                </svg>
            </div>`;
        }

        cardDiv.innerHTML = `
            ${logoHtml}
            <div class="card-preview-title">${this.escapeHtml(card.name)}</div>
        `;

        // Открытие детального просмотра при клике
        cardDiv.addEventListener('click', () => {
            this.openCardDetail(card.id);
        });

        return cardDiv;
    }

    // Переключение избранного статуса
    toggleFavorite(cardId) {
        const card = this.cards.find(c => c.id === cardId);
        if (!card) return;

        card.favorite = !card.favorite;
        this.saveCards();
        this.renderCards();

        // Обновляем кнопку избранного в открытой карточке без повторного открытия
        const detailModal = document.getElementById('cardDetailModal');
        if (detailModal && detailModal.classList.contains('show')) {
            const favoriteBtn = detailModal.querySelector('.card-favorite-btn');
            if (favoriteBtn) {
                favoriteBtn.classList.toggle('active', card.favorite);
                favoriteBtn.innerHTML = this.getStarSvg(card.favorite, 'star-icon--large');
            }
        }
    }

    /**
     * Генерирует штрих-код с помощью bwip-js
     * @param {string} elementId — ID элемента (canvas или div)
     * @param {string} value     — данные для кодирования
     * @param {string} type      — тип штрих-кода: 'pdf417', 'qrcode', 'code128', 'itf', 'ean13' и т.д.
     * @param {object} options   — дополнительные настройки (необязательно)
     */
    generateBarcode(elementId, value, type, options = {}) {
        const element = document.getElementById(elementId);
        if (!element) {
            console.error('Элемент не найден:', elementId);
            return;
        }

        // Ожидание загрузки bwip-js (если подключаешь через <script src="...">)
        if (typeof bwipjs === 'undefined') {
            let attempts = 0;
            const checkInterval = setInterval(() => {
                attempts++;
                if (typeof bwipjs !== 'undefined') {
                    clearInterval(checkInterval);
                    generateBarcode(elementId, value, type, options); // рекурсивный вызов
                } else if (attempts > 50) { // ~5 секунд
                    clearInterval(checkInterval);
                    element.innerHTML = '<p style="color:red;">Ошибка: библиотека bwip-js не загрузилась</p>';
                    console.error('bwip-js не загружен');
                }
            }, 100);
            return;
        }

        // Очищаем содержимое
        element.innerHTML = '';

        // Создаём canvas (bwip-js работает только с canvas)
        const canvas = document.createElement('canvas');
        canvas.style.width = '100%'
        element.appendChild(canvas);

        try {
            // Стандартные настройки по умолчанию
            const defaultOptions = {
                bcid: type.toLowerCase(),   // обязательный параметр bwip-js
                text: value,
                scale: 3,                    // масштаб (1–10, 3 — хороший баланс)
                height: 15,                   // высота в мм (для 1D), для 2D влияет на размер модуля
                includetext: true,                 // показывать текст под штрих-кодом
                textxalign: 'center',
                textyoffset: 10,
                backgroundcolor: 'FFFFFF',
                padding: 10,
                // Для QR-кодов лучше отключать текст и увеличивать масштаб
                ...(type.toLowerCase() === 'qrcode' && {
                    includetext: false,
                    scale: 5,
                    //version: 'auto' // или конкретный номер, если нужно
                }),
                // Для PDF417 тоже можно подправить
                ...(type.toLowerCase() === 'pdf417' && {
                    includetext: true,
                    height: 20
                })
            };

            // Перезаписываем дефолты пользовательскими опциями
            const finalOptions = { ...defaultOptions, ...options };

            // Генерация
            bwipjs.toCanvas(canvas, finalOptions);

        } catch (err) {
            console.error('Ошибка генерации штрих-кода bwip-js:', err);
            element.innerHTML = `
            <p style="color:red; padding:10px; font-family:sans-serif;">
                Ошибка генерации ${type.toUpperCase()}:<br>
                <small>${err.message || 'Некорректные данные или неподдерживаемый тип'}</small>
            </p>`;
        }
    }

    // Экранирование HTML для безопасности
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Добавление категории
    async addCategory() {
        const categoryName = document.getElementById('newCategoryName').value.trim();
        if (!categoryName) {
            await this.showAlert('Введите название категории');
            return;
        }

        if (this.categories.includes(categoryName)) {
            await this.showAlert('Категория с таким названием уже существует');
            return;
        }

        this.categories.push(categoryName);
        this.saveSettings();
        this.updateCategorySelects();
        this.updateCategoryFilters();
        document.getElementById('cardCategory').value = categoryName;
        this.closeCategoryModal();
    }

    // Открытие модального окна категории
    openCategoryModal() {
        const modal = document.getElementById('categoryModal');
        document.getElementById('newCategoryName').value = '';
        modal.classList.add('show');

        // Добавляем запись в историю для обработки кнопки "назад"
        this.pushModalState('category');
    }

    // Закрытие модального окна категории
    closeCategoryModal() {
        const modal = document.getElementById('categoryModal');
        if (modal && modal.classList.contains('show')) {
            modal.classList.remove('show');
            document.getElementById('categoryForm').reset();
            this.popModalState('category');
        }
    }

    // Оценка размера базы данных (сериализованные карты из IndexedDB) в байтах
    getDbSizeBytes() {
        try {
            // Blob.size даёт точный размер строки в байтах (UTF-8)
            return new Blob([JSON.stringify(this.cards)]).size;
        } catch (err) {
            // Резервная оценка: длина JSON-строки в символах
            return JSON.stringify(this.cards).length;
        }
    }

    // Форматирование размера в байтах: Б, КБ или МБ
    formatSize(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) return '—';
        if (bytes < 1024) return `${bytes} Б`;
        const kb = bytes / 1024;
        if (kb < 1024) return `${kb.toFixed(1)} КБ`;
        return `${(kb / 1024).toFixed(2)} МБ`;
    }

    // Открытие модального окна "О программе"
    openAboutModal() {
        const modal = document.getElementById('aboutModal');

        // Статистика вычисляется на момент открытия окна
        const cardCount = document.getElementById('aboutCardCount');
        const dbSize = document.getElementById('aboutDbSize');
        if (cardCount) cardCount.textContent = String(this.cards.length);
        if (dbSize) dbSize.textContent = this.formatSize(this.getDbSizeBytes());

        modal.classList.add('show');

        this.pushModalState('about');
    }

    // Закрытие модального окна "О программе"
    closeAboutModal() {
        const modal = document.getElementById('aboutModal');
        if (modal && modal.classList.contains('show')) {
            modal.classList.remove('show');
            this.popModalState('about');
        }
    }

    // === Экспорт и импорт карт ===

    // Открытие модального окна экспорта/импорта.
    // Вызывается из окна "О программе", которое при этом закрывается: его место
    // в стеке модалок и в истории занимает окно экспорта/импорта (запись about
    // в истории заменяется записью data — лишний шаг «Назад» не появляется).
    openDataModal() {
        const modal = document.getElementById('dataModal');
        const aboutModal = document.getElementById('aboutModal');
        const fileInput = document.getElementById('importFile');
        const urlInput = document.getElementById('importUrl');

        // Сбрасываем предыдущий выбранный файл
        if (fileInput) {
            fileInput.value = '';
        }
        // Подставляем последний использованный адрес загрузки по URL
        if (urlInput) {
            urlInput.value = this.importUrl || '';
        }

        // Закрытие окна "О программе" с учётом стека открытых модалок
        const aboutWasOpen = aboutModal && aboutModal.classList.contains('show');
        if (aboutWasOpen) {
            aboutModal.classList.remove('show');
            this.modalStack = this.modalStack.filter(id => id !== 'aboutModal');
        }

        modal.classList.add('show');

        if (!this.modalStack.includes('dataModal')) {
            this.modalStack.push('dataModal');
        }

        if (aboutWasOpen && history.state && history.state.modal === 'about') {
            // Запись about в истории превращается в запись data
            history.replaceState({ modal: 'data' }, '', window.location.pathname);
        } else {
            history.pushState({ modal: 'data' }, '', window.location.pathname);
        }
    }

    // Закрытие модального окна экспорта/импорта
    closeDataModal() {
        const modal = document.getElementById('dataModal');
        if (modal && modal.classList.contains('show')) {
            modal.classList.remove('show');
            this.popModalState('data');
        }
    }

    // Экспорт всех карт в JSON-файл (массив)
    exportCards() {
        try {
            const data = JSON.stringify(this.cards, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const date = new Date().toISOString().slice(0, 10);

            link.href = url;
            link.download = `discount-plus-cards-${date}.json`;
            document.body.appendChild(link);
            link.click();
            link.remove();

            // Освобождаем объект URL чуть позже, чтобы скачивание успело начаться
            setTimeout(() => URL.revokeObjectURL(url), 1000);

            this.showAlert(`Экспортировано карт: ${this.cards.length}`);
        } catch (err) {
            console.error('Ошибка экспорта карт:', err);
            this.showAlert('Не удалось сохранить файл. Попробуйте ещё раз.', 'Ошибка экспорта');
        }
    }

    // Чтение текста выбранного файла (FileReader — как при загрузке логотипа)
    readFileText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл'));
            reader.readAsText(file);
        });
    }

    // Разбор и валидация JSON-массива карт. Возвращает { cards, skipped },
    // где skipped — количество пропущенных некорректных записей.
    // Бросает ошибку с понятным пользователю сообщением.
    parseImportedCards(text) {
        let data;
        try {
            data = JSON.parse(text);
        } catch (err) {
            throw new Error('Данные не являются корректным JSON.');
        }

        if (!Array.isArray(data)) {
            throw new Error('Данные должны быть JSON-массивом карт.');
        }

        const cards = [];
        const usedIds = new Set();
        let skipped = 0;

        data.forEach((item, index) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                skipped++;
                return;
            }

            const name = typeof item.name === 'string' ? item.name.trim() : '';
            const barcodeValue = typeof item.barcodeValue === 'string' ? item.barcodeValue.trim() : '';
            // Обязательные поля — как в форме карты
            if (!name || !barcodeValue) {
                skipped++;
                return;
            }

            // Идентификатор обязателен и уникален (keyPath 'id' в IndexedDB)
            let id = (typeof item.id === 'string' || typeof item.id === 'number') ? String(item.id) : '';
            if (!id || usedIds.has(id)) {
                id = `import-${Date.now()}-${index}`;
            }
            usedIds.add(id);

            cards.push({
                id: id,
                name: name,
                translit: typeof item.translit === 'string' ? item.translit : null,
                category: (typeof item.category === 'string' && item.category.trim()) ? item.category.trim() : null,
                color: (typeof item.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(item.color)) ? item.color : '#9b68cd',
                favorite: item.favorite === true,
                barcodeType: (typeof item.barcodeType === 'string' && item.barcodeType) ? item.barcodeType : 'CODE128',
                barcodeValue: barcodeValue,
                additionalInfo: typeof item.additionalInfo === 'string' ? item.additionalInfo : '',
                logo: typeof item.logo === 'string' ? item.logo : null,
                createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString()
            });
        });

        if (cards.length === 0) {
            throw new Error('В данных не найдено ни одной корректной карты (обязательны поля name и barcodeValue).');
        }

        return { cards: cards, skipped: skipped };
    }

    // Диалог подтверждения импорта с предупреждениями
    confirmImport(count, skipped = 0) {
        let message = `Импорт заменит ВСЕ текущие карты и категории. Будет загружено карт: ${count}. Действие необратимо.`;
        if (skipped > 0) {
            message += ` Некорректных записей пропущено: ${skipped}.`;
        }
        message += ' Будьте осторожны с файлами и ссылками из неизвестных источников!';

        return this.showConfirm(message, {
            title: 'Импорт карт',
            okText: 'Импортировать',
            danger: true
        });
    }

    // Импорт из выбранного файла
    async handleImportFile(event) {
        const input = event.target;
        const file = input.files && input.files[0];
        if (!file) {
            return;
        }

        try {
            const text = await this.readFileText(file);
            const parsed = this.parseImportedCards(text);

            const confirmed = await this.confirmImport(parsed.cards.length, parsed.skipped);
            if (!confirmed) {
                return;
            }

            await this.applyImportedCards(parsed.cards);
            this.closeDataModal();
        } catch (err) {
            console.error('Ошибка импорта из файла:', err);
            const message = err && err.message ? err.message : 'Не удалось импортировать данные из файла.';
            this.showAlert(message, 'Ошибка импорта');
        } finally {
            // Сбрасываем input, чтобы можно было выбрать тот же файл повторно
            input.value = '';
        }
    }

    // Импорт по URL
    async handleImportUrl() {
        const urlInput = document.getElementById('importUrl');
        const url = (urlInput && urlInput.value ? urlInput.value : '').trim();

        if (!url) {
            this.showAlert('Введите ссылку на JSON-файл с картами.');
            return;
        }

        let text;
        try {
            // cache: 'no-store' — всегда запрашиваем свежие данные
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`Сервер вернул ошибку HTTP ${response.status}`);
            }
            text = await response.text();
        } catch (err) {
            console.error('Ошибка загрузки по URL:', err);
            this.showAlert('Не удалось загрузить данные по ссылке. Проверьте адрес и доступность ресурса. ' +
                'Учтите: сервер должен разрешать кросс-доменные запросы (CORS).', 'Ошибка загрузки');
            return;
        }

        let parsed;
        try {
            parsed = this.parseImportedCards(text);
        } catch (err) {
            this.showAlert(err.message, 'Ошибка импорта');
            return;
        }

        const confirmed = await this.confirmImport(parsed.cards.length, parsed.skipped);
        if (!confirmed) {
            return;
        }

        // Запоминаем адрес для подстановки в форму при следующем открытии
        this.importUrl = url;
        await this.applyImportedCards(parsed.cards);
        this.closeDataModal();
    }

    // Применение импортированных карт: полная замена данных и обновление интерфейса
    async applyImportedCards(cards) {
        // Карты заменяются целиком (в IndexedDB — одной транзакцией)
        this.cards = cards;
        await this.saveCards();

        // Категории пересобираются из импортированных карт
        const categories = [];
        cards.forEach(card => {
            if (card.category && !categories.includes(card.category)) {
                categories.push(card.category);
            }
        });
        this.categories = categories;

        // Если сохранённый фильтр по категории больше не существует — сбрасываем его
        if (this.filterCategory && !categories.includes(this.filterCategory)) {
            this.filterCategory = '';
        }

        // Сохраняет категории, фильтры и importUrl ключом discountPlus
        this.saveSettings();

        // Обновляем интерфейс: селекты, фильтры и список карт
        this.updateCategorySelects();
        this.updateCategoryFilters();
        this.applyFilters();
        this.renderCards();
    }
}

// Инициализация приложения
let app;
window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('APP_VERSION').textContent = APP_VERSION;
    app = new LoyaltyCardsApp();
});
