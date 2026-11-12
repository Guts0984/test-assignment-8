import type { Category } from '@helpdesk/shared';

export const FIRST_NAMES = [
  'Олександр',
  'Марія',
  'Іван',
  'Олена',
  'Андрій',
  'Наталія',
  'Сергій',
  'Тетяна',
  'Дмитро',
  'Юлія',
  'Богдан',
  'Ірина',
  'Максим',
  'Оксана',
  'Віктор',
  'Софія',
  'Роман',
  'Анна',
  'Павло',
  'Катерина',
];
export const LAST_NAMES = [
  'Шевченко',
  'Коваленко',
  'Бондаренко',
  'Мельник',
  'Ткаченко',
  'Кравчук',
  'Олійник',
  'Савчук',
  'Лисенко',
  'Петренко',
  'Мазур',
  'Поліщук',
  'Гончар',
  'Кузьменко',
  'Вовк',
  'Руденко',
];

export const AGENTS: ReadonlyArray<{ name: string; categories: readonly Category[] }> = [
  { name: 'Іван Мельник', categories: ['payment', 'other'] },
  { name: 'Олена Шевченко', categories: ['delivery', 'other'] },
  { name: 'Андрій Ткаченко', categories: ['account', 'technical'] },
  { name: 'Наталія Бондаренко', categories: ['technical', 'payment'] },
  { name: 'Сергій Кравчук', categories: ['delivery', 'account'] },
  { name: 'Тетяна Лисенко', categories: ['other', 'payment', 'delivery'] },
];

export const SUBJECTS: Readonly<Record<Category, readonly string[]>> = {
  payment: [
    'Не проходить оплата карткою',
    'Подвійне списання коштів',
    'Повернення коштів за замовлення',
    'Payment failed at checkout',
    'Invoice request for last month',
    'Промокод не застосовується',
  ],
  delivery: [
    'Замовлення не доставлено вчасно',
    'Змінити адресу доставки',
    'Посилка пошкоджена',
    'Where is my parcel?',
    'Кур’єр не виходить на зв’язок',
    'Неправильний трек-номер',
  ],
  account: [
    'Не можу увійти в акаунт',
    'Змінити електронну пошту',
    'Видалити мій акаунт',
    'Password reset email not arriving',
    'Двофакторна автентифікація не працює',
    'Заблоковано акаунт',
  ],
  technical: [
    'Помилка 500 на сторінці замовлення',
    'Додаток вилітає при запуску',
    'Сайт не завантажується',
    'Cannot upload a photo',
    'Не приходять push-сповіщення',
    'Wrong total in the cart',
  ],
  other: [
    'Питання щодо співпраці',
    'Пропозиція щодо покращення сервісу',
    'Скарга на обслуговування',
    'General question about warranty',
    'Як отримати чек?',
    'Дякую за швидку допомогу',
  ],
};

export const CUSTOMER_BODIES = [
  'Доброго дня! Підкажіть, будь ласка, що робити в цій ситуації? Дякую.',
  'Проблема повторюється вже кілька днів, прошу допомогти якнайшвидше.',
  'Hello, I tried everything from your FAQ but nothing helps. Could you take a look?',
  'Додаю деталі: помилка з’являється щоразу після підтвердження дії.',
  'Thanks for the reply, but the issue is still there.',
  'Так, я перевірив(-ла) — результат той самий.',
];
export const AGENT_BODIES = [
  'Дякуємо за звернення! Ми вже перевіряємо вашу ситуацію.',
  'Будь ласка, уточніть, чи спробували ви повторити дію з іншого пристрою?',
  'We have escalated this to the responsible team and will update you shortly.',
  'Питання вирішено з нашого боку. Якщо проблема повториться — напишіть нам.',
  'Просимо надіслати скріншот помилки, це допоможе швидше знайти причину.',
  'Ми скоригували налаштування вашого облікового запису. Перевірте, будь ласка.',
];
export const INTERNAL_NOTES = [
  'Клієнт уже звертався раніше, див. попередню заявку.',
  'Передано в бухгалтерію, чекаємо підтвердження.',
  'Перевірив логи — помилка на стороні платіжного провайдера.',
  'VIP-клієнт, відповідаємо в пріоритеті.',
];
export const RATING_COMMENTS = [
  'Дякую, все швидко вирішили!',
  'Довго чекав(-ла) на відповідь.',
  'Great support, thanks!',
  'Проблему вирішили, але не з першого разу.',
];
export const TAGS = ['vip', 'refund', 'bug', 'repeat', 'feedback', 'chargeback', 'fraud-check'];

export const CANNED: ReadonlyArray<{ title: string; body: string; category: Category | null }> = [
  {
    title: 'Вітання',
    body: 'Доброго дня, {{customer_name}}! Дякуємо за звернення {{ticket_number}}. Вже розбираємось.',
    category: null,
  },
  {
    title: 'Повернення коштів',
    body: '{{customer_name}}, повернення коштів за {{ticket_number}} буде оформлено протягом 3–5 робочих днів.',
    category: 'payment',
  },
  {
    title: 'Уточнення адреси',
    body: '{{customer_name}}, підтвердьте, будь ласка, адресу доставки для заявки {{ticket_number}}.',
    category: 'delivery',
  },
  {
    title: 'Скидання пароля',
    body: '{{customer_name}}, ми надіслали інструкцію зі скидання пароля. Заявка {{ticket_number}}.',
    category: 'account',
  },
  {
    title: 'Потрібен скріншот',
    body: '{{customer_name}}, надішліть, будь ласка, скріншот помилки — {{ticket_number}}.',
    category: 'technical',
  },
  {
    title: 'Закриття',
    body: 'Раді, що вдалося допомогти, {{customer_name}}! Заявку {{ticket_number}} позначено як вирішену.',
    category: null,
  },
];
