export const changelogLocales = {
  he: {
    dir: "rtl", dateLocale: "he-IL",
    ui: {
      pageTitle: "יומן השינויים — Hunch", pageDescription: "כל גרסאות Hunch — מזיכרון הנדסי שנשמר ב-Git ועד התאמה ארכיטקטונית לקוד AI.",
      mainNav: "ניווט ראשי", language: "שפה", navHow: "כך זה עובד", navInside: "מאחורי הקלעים", docs: "תיעוד", blog: "בלוג", changelog: "יומן שינויים", getStarted: "מתחילים",
      eyebrow: "יומן שינויים · החדש ביותר תחילה", heading: "כל גרסה, מאז <em>v0.1</em>.", intro: "מגרף החלטות שנשמר ב-Git ועד התאמה ארכיטקטונית דטרמיניסטית — כל הדרך, מהחדש לישן.",
      footer: "© Hunch — התאמה ארכיטקטונית לקוד AI.", home: "בית", githubReleases: "גרסאות ב-GitHub"
    },
    titles: [
      "נוף הנדסי שנבדק נשאר עדכני בבטחה",
      "נתיב זיכרון מאומת אחד — מהסיבה לתוצאה",
      "ראיות הגרסה במקום שבו מתקינים",
      "חיפוש תיקונים עם גבולות ראייתיים",
      "רשומות ADR שהוצאו משימוש כבר לא ממציאות מחליפים",
      "YAML ו-Helm נכנסים לגרף",
      "הייצוא מבחין כשהוא נרקב",
      "גשר MADR — ייבוא וייצוא של רשומות ADR",
      "תמיכה ב-Go",
      "הקשר מגיע עם שכניו בגרף",
      "קבלות מסירת MCP מגיעות כנתונים מובנים",
      "מעטפות מסירה אמינות עם בדיקת מקור", "עיגון שלא הגיע ל-Windows", "זיכרון ששומר קבלות", "עיגון ששורד האצלה ודחיסה", "כלל חוסם רק אם מישהו באמת חתם עליו", "הסיבות שנרשמות באמת נבדקות", "זיכרון שמציין מי חתם עליו", "חיפוש שלא מצא את שמות הפונקציות", "מיזוג שהחזיר בשקט באגים סגורים למצב פתוח", "זיכרון שהפסיק להישמר, וזיכרון שלא נמצא בחיפוש", "החלטה שנדחתה כבר לא חוסמת commits", "מנגנוני אכיפה שנכשלו בשקט ואישרו הכול", "גל ביקורת הקוד — 28 ליקויים נסגרו ביום אחד", "ממצאים — זיכרון לכל מה שנצפה ועדיין לא תוקן",
      "MCP מבודד והתקנות ניתנות לשחזור", "קבלות מהדורת npm מאומתות", "OIDC של npm מגיע לרישום", "פרסום תוסף דרך Open VSX בלבד", "זיכרון הנדסי חי אחד לכל הצוות", "פרסום npm שלא פג תוקף", "CI מחמיר שנשאר זמין", "ניסויים שעברו בדיקת סוקרים וגבול שוק ברור יותר",
      "מסלול קצר יותר מהתקנה לזיכרון שימושי", "תמיכה ב-Python", "זיכרון שפועל בעצמו", "בחירת מנוי בלי להינעל לספק",
      "צינור האימות — המסירה נאכפת, לא רק מקווים לה", "היכרות ראשונה ידידותית יותר", "אחזור שעוקב אחרי הגרף, לא רק מילות מפתח", "ה-wiki יודעת מה קורה ומה הלאה", "לולאת סוכן שקטה ומדויקת יותר",
      "ה-wiki מאמצת את התיעוד — עם שער drift", "תשתית אמינה ושקופה", "hunch structure — המבנה לפני grep", "תוסף Claude Code והמאגר מדגים את עצמו", "AGENTS.md כמשטח drift", "hunch impact + hunch path — רואים את ההשפעה והמסלול", "1.0 — אינדקס בלי תלויות native",
      "מקור אמת אחד לזיכרון", "auto-commit מופעל כברירת מחדל", "אבטחה — חיזוק גילוי מאגר הצוות", "עיגון החלטות — החיבור בין התיעוד לגרף", "עיגון בזמן קריאה + שער drift", "החלטה פעילה אחת לכל נושא", "hunch heal + /capture ו-/heal",
      "בטיחות auto-commit בשכבת overlay", "התאמה ארכיטקטונית לקוד AI", "תמונת אכיפה אחת + עיגון בכל מקום", "התאמת כללים מדויקת יותר", "אילוצים לפי תוכן + hooks בטוחים ל-symlink", "זיכרון אחד בין branches ו-worktrees", "זיכרון חלק בין כמה branches ו-worktrees",
      "תמיכה ב-Google Antigravity", "התאמת כוונה", "לכידת כוונה בתוך הקוד", "hunch compare — דירוג כמה מועמדים", "זיכרון runbooks", "בדיקות drift לזיכרון", "סביבת מדידה לאחזור", "אחזור מועשר בגרף",
      "Deep Synthesis", "שכבת זיכרון פרטית", "Redundancy Guard — זה כבר קיים", "Veto — שומר ההחלטות", "Causal Merge Verdict", "Never Twice — תיקונים הופכים לכללים", "CI Constraint Guard", "ב-npm + מצב strict בטוח",
      "תמיכה ב-Windsurf", "זיכרון מסע בזמן + Regression Guard", "hooks לסוכן + רמות אכיפה", "סינתזה עם כמה CLI-ים", "כמה עוזרים, גרף אחד", "מנגנוני הגנה בכל מקום", "כמעט-הפרות לפי טווח השפעה", "תיקון drift", "לולאת למידה מכשלים", "גרסה ראשונה"
    ]
  },
  ru: {
    dir: "ltr", dateLocale: "ru-RU",
    ui: {
      pageTitle: "История изменений — Hunch", pageDescription: "Все выпуски Hunch: от инженерной памяти в Git до архитектурного соответствия для ИИ-кода.",
      mainNav: "Основная навигация", language: "Язык", navHow: "Как это работает", navInside: "Что внутри", docs: "Документация", blog: "Блог", changelog: "История изменений", getStarted: "Начать",
      eyebrow: "история изменений · сначала новые", heading: "Все выпуски, начиная с <em>v0.1</em>.", intro: "От графа решений в Git до детерминированного архитектурного соответствия — вся история, от новых выпусков к старым.",
      footer: "© Hunch — архитектурное соответствие для ИИ-кода.", home: "Главная", githubReleases: "Релизы на GitHub"
    },
    titles: [
      "Проверенный инженерный ландшафт безопасно остаётся актуальным",
      "Единый проверяемый путь памяти — от причины к результату",
      "Доказательства выпуска там, где устанавливают",
      "Поиск исправлений с границами доказательности",
      "Устаревшие ADR больше не выдумывают преемников",
      "YAML и Helm входят в граф",
      "Экспорт замечает, что протух",
      "Мост MADR — импорт и экспорт записей ADR",
      "Поддержка Go",
      "Контекст приходит вместе с соседями по графу",
      "Квитанции доставки MCP теперь приходят как структурированные данные",
      "Достоверные конверты доставки с проверкой происхождения", "Обоснование, которое не доходило до Windows", "Память, которая хранит квитанции", "Обоснование, переживающее делегирование и сжатие", "Правило блокирует, только если его действительно подписали", "Записанные причины действительно проверяются", "Память, которая указывает, кто за неё поручился", "Поиск, не находивший имена ваших собственных функций", "Слияние, тихо возвращавшее закрытые баги в открытые", "Память, которая перестала сохраняться, и память, которую было не найти", "Отвергнутое решение больше не блокирует ваши коммиты", "Защитные механизмы, которые молча пропускали нарушения", "Волна аудита кода — 28 дефектов закрыто за один день", "Findings — память о том, что вы заметили, но ещё не исправили",
      "Изолированный MCP и воспроизводимые установки", "Проверенные квитанции выпуска npm", "npm OIDC достигает реестра", "Публикация расширения только через Open VSX", "Единая живая инженерная память для всей команды", "Публикация npm без истекающих учётных данных", "Строгий CI, который остаётся доступным", "Эксперименты с независимой оценкой и более ясная граница рынка",
      "Более короткий путь от установки к полезной памяти", "Поддержка Python", "Память, которая работает сама", "Выбор подписки без привязки к поставщику",
      "Конвейер проверки — доставка гарантирована", "Более дружелюбное первое знакомство", "Поиск следует графу, а не только ключевым словам", "Wiki знает, что происходит и что дальше", "Более тихий и точный цикл агента",
      "Wiki принимает ваши документы под контроль дрейфа", "Честная и надёжная инфраструктура", "hunch structure — структура до grep", "Плагин Claude Code и самодемонстрирующийся репозиторий", "AGENTS.md как поверхность дрейфа", "hunch impact + hunch path — влияние и путь", "1.0 — индекс без нативных зависимостей",
      "Единый источник истины для памяти", "Auto-commit включён по умолчанию", "Безопасность — усиленное обнаружение командного хранилища", "Привязка решений — связь документации с графом", "Контекст при чтении + барьер дрейфа", "Одно действующее решение на тему", "hunch heal + /capture и /heal",
      "Безопасный auto-commit приватного слоя", "Архитектурное соответствие для ИИ-кода", "Состояние контроля одним взглядом + контекст везде", "Более точное сопоставление правил", "Ограничения по содержимому + безопасные symlink-hooks", "Одна память между ветками и worktree", "Бесшовная память для нескольких веток и worktree",
      "Поддержка Google Antigravity", "Соответствие намерению", "Захват намерения прямо в коде", "hunch compare — вердикт для нескольких кандидатов", "Память runbook-процедур", "Проверки дрейфа памяти", "Стенд оценки поиска", "Поиск, усиленный графом",
      "Deep Synthesis", "Приватный слой памяти", "Redundancy Guard — это уже существует", "Veto — защита решений", "Causal Merge Verdict", "Never Twice — исправления становятся правилами", "CI Constraint Guard", "Публикация в npm + безопасный strict-режим",
      "Поддержка Windsurf", "Память с путешествием во времени + Regression Guard", "Hooks агента + уровни строгости", "Синтез через несколько CLI", "Несколько помощников, один граф", "Защитные механизмы повсюду", "Почти-нарушения по радиусу влияния", "Исправление дрейфа", "Цикл обучения на сбоях", "Первый выпуск"
    ]
  },
  ar: {
    dir: "rtl", dateLocale: "ar",
    ui: {
      pageTitle: "سجل التغييرات — Hunch", pageDescription: "كل إصدارات Hunch، من الذاكرة الهندسية المحفوظة في Git إلى التوافق المعماري لكود الذكاء الاصطناعي.",
      mainNav: "التنقل الرئيسي", language: "اللغة", navHow: "كيف يعمل", navInside: "ما وراء الكواليس", docs: "الوثائق", blog: "المدونة", changelog: "سجل التغييرات", getStarted: "ابدأ الآن",
      eyebrow: "سجل التغييرات · الأحدث أولاً", heading: "كل إصدار، منذ <em>v0.1</em>.", intro: "من رسم قرارات محفوظ في Git إلى توافق معماري حتمي — الرحلة كاملة، من الأحدث إلى الأقدم.",
      footer: "© Hunch — التوافق المعماري لكود الذكاء الاصطناعي.", home: "الرئيسية", githubReleases: "الإصدارات على GitHub"
    },
    titles: [
      "يبقى المشهد الهندسي المُراجع محدثًا بأمان",
      "مسار ذاكرة واحد موثّق من السبب إلى النتيجة",
      "أدلة الإصدار حيث يتم التثبيت",
      "بحث تصحيحات مضبوط بحدود الأدلة",
      "سجلات ADR المهملة لم تعد تختلق خلفاء",
      "YAML وHelm يدخلان الرسم البياني",
      "التصدير يلاحظ حين يفسد",
      "جسر MADR — استيراد سجلات ADR وتصديرها",
      "دعم Go",
      "سياق يصل مع جيرانه في الرسم البياني",
      "إيصالات تسليم MCP تصل كبيانات منظّمة",
      "مغلفات تسليم موثوقة مع تحقق من المصدر", "تأسيس لم يكن يصل إلى Windows", "ذاكرة تحتفظ بالإيصالات", "تأسيس يصمد أمام التفويض والضغط", "القاعدة لا تحجب إلا إذا وقّعها إنسان فعلاً", "الأسباب المدوَّنة تُفحص فعلاً", "ذاكرة تُبيّن من صادق عليها", "بحث لا يعثر على أسماء دوالّك نفسها", "دمج كان يعيد الخلل المُغلق إلى الحالة المفتوحة بصمت", "ذاكرة توقّفت عن الحفظ، وذاكرة لا تعثر عليها", "قرار مرفوض لم يعد يحظر الـ commits", "حرّاس كانوا يُجيزون ما عجزوا عن فحصه", "موجة المراجعة — إغلاق 28 خللاً في يوم واحد", "الملاحظات — ذاكرة لكل ما اكتشفته ولم تُصلحه بعد",
      "MCP معزول وتثبيتات قابلة لإعادة الإنتاج", "إيصالات إصدار npm موثّقة", "وصول OIDC الخاص بـnpm إلى السجل", "نشر الإضافة عبر Open VSX فقط", "ذاكرة هندسية حية واحدة للفريق كله", "نشر npm بلا بيانات اعتماد منتهية الصلاحية", "تكامل مستمر صارم يبقى متاحًا", "تجارب مؤهلة بالمراجعة وحدود سوق أوضح",
      "طريق أقصر من التثبيت إلى ذاكرة مفيدة", "دعم Python", "ذاكرة تعمل بنفسها", "اختيار الاشتراك من دون ارتهان لمزوّد",
      "مسار التحقق — تسليم مضمون لا مجرد أمل", "ترحيب أول أكثر وضوحاً", "استرجاع يتبع الرسم البياني لا الكلمات فقط", "الـwiki تعرف ما يحدث وما التالي", "حلقة وكيل أهدأ وأكثر دقة",
      "الـwiki تتولى توثيقك تحت بوابة الانحراف", "بنية تحتية صادقة وموثوقة", "hunch structure — البنية قبل grep", "إضافة Claude Code والمستودع يشرح نفسه", "AGENTS.md كسطح للانحراف", "hunch impact + hunch path — الأثر والمسار", "1.0 — فهرس بلا تبعيات native",
      "مصدر حقيقة واحد للذاكرة", "تشغيل auto-commit افتراضياً", "الأمان — تقوية اكتشاف مخزن الفريق", "ربط القرارات — صلة الوثائق بالرسم", "تأصيل وقت القراءة + بوابة الانحراف", "قرار حي واحد لكل موضوع", "hunch heal + /capture و/ـheal",
      "أمان auto-commit للطبقة الخاصة", "التوافق المعماري لكود الذكاء الاصطناعي", "الإنفاذ بنظرة واحدة + السياق في كل مكان", "مطابقة قواعد أكثر دقة", "قيود حسب المحتوى + hooks آمنة للروابط الرمزية", "ذاكرة واحدة بين الفروع وworktrees", "ذاكرة سلسة لعدة فروع وworktrees",
      "دعم Google Antigravity", "التوافق مع القصد", "التقاط القصد داخل الكود", "hunch compare — حكم على عدة مرشحين", "ذاكرة إجراءات runbook", "فحوص انحراف الذاكرة", "بيئة قياس للاسترجاع", "استرجاع معزّز بالرسم البياني",
      "Deep Synthesis", "طبقة ذاكرة خاصة", "Redundancy Guard — هذا موجود بالفعل", "Veto — حارس القرارات", "Causal Merge Verdict", "Never Twice — التصحيحات تصبح قواعد", "CI Constraint Guard", "على npm + وضع strict آمن",
      "دعم Windsurf", "ذاكرة عبر الزمن + Regression Guard", "hooks للوكيل + مستويات الصرامة", "توليف عبر عدة واجهات CLI", "عدة مساعدين، رسم واحد", "حواجز حماية في كل مكان", "خروقات قريبة حسب نطاق التأثير", "إصلاح الانحراف", "حلقة تعلم من الأعطال", "الإصدار الأول"
    ]
  },
  es: {
    dir: "ltr", dateLocale: "es-ES",
    ui: {
      pageTitle: "Registro de cambios — Hunch", pageDescription: "Todas las versiones de Hunch: desde memoria de ingeniería en Git hasta conformidad arquitectónica para código de IA.",
      mainNav: "Navegación principal", language: "Idioma", navHow: "Cómo funciona", navInside: "Cómo está hecho", docs: "Documentación", blog: "Blog", changelog: "Cambios", getStarted: "Empezar",
      eyebrow: "registro de cambios · lo más reciente primero", heading: "Cada versión, desde <em>v0.1</em>.", intro: "Del grafo de decisiones nativo de Git a la conformidad arquitectónica determinista: toda la historia, de lo nuevo a lo antiguo.",
      footer: "© Hunch — conformidad arquitectónica para código de IA.", home: "Inicio", githubReleases: "Versiones en GitHub"
    },
    titles: [
      "El panorama de ingeniería revisado se mantiene actualizado con seguridad",
      "Una ruta de memoria verificable, de la razón al resultado",
      "La evidencia de la versión donde se instala",
      "Búsqueda de correcciones con límites de evidencia",
      "Los ADR obsoletos ya no inventan sucesores",
      "YAML y Helm entran en el grafo",
      "La exportación nota cuándo se pudre",
      "El puente MADR: importar y exportar registros ADR",
      "Compatibilidad con Go",
      "El contexto llega con sus vecinos del grafo",
      "Los recibos de entrega MCP llegan como datos estructurados",
      "Sobres de entrega fiables con procedencia verificada", "Grounding que nunca llegaba a Windows", "Memoria que guarda recibos", "Grounding que sobrevive a la delegación y la compactación", "Una regla solo bloquea si alguien la firmó de verdad", "Las razones que anotas sí se comprueban", "Memoria que dice quién la avaló", "Una búsqueda que no encontraba los nombres de tus propias funciones", "Una fusión que reabría en silencio los errores ya cerrados", "Memoria que dejaba de guardarse y memoria que no encontrabas", "Una decisión rechazada ya no bloquea tus commits", "Protecciones que dejaban pasar infracciones en silencio", "La auditoría masiva: 28 defectos cerrados en un día", "Hallazgos: memoria para lo que has observado pero aún no has corregido",
      "MCP aislado e instalaciones reproducibles", "Recibos de publicación npm verificados", "OIDC de npm llega al registro", "Publicación de la extensión solo mediante Open VSX", "Una memoria de ingeniería viva para todo el equipo", "Publicación en npm sin credenciales que caduquen", "CI estricto que permanece disponible", "Experimentos validados por revisores y un límite de mercado más claro",
      "Un camino más corto desde la instalación hasta una memoria útil", "Compatibilidad con Python", "Memoria que funciona sola", "Elegir suscripción sin quedar atado a un proveedor",
      "La canalización de verificación: entrega garantizada", "Una primera bienvenida más amable", "La recuperación sigue el grafo, no solo las palabras", "La wiki sabe qué ocurre y qué viene después", "Un ciclo de agente más silencioso y preciso",
      "La wiki adopta tus documentos bajo una barrera de deriva", "Infraestructura honesta y fiable", "hunch structure: la estructura antes de grep", "Plugin de Claude Code y un repositorio que se demuestra a sí mismo", "AGENTS.md como superficie de deriva", "hunch impact + hunch path: impacto y recorrido", "1.0: índice sin dependencias nativas",
      "Una fuente de verdad para la memoria", "Auto-commit activado por defecto", "Seguridad: descubrimiento del almacén de equipo reforzado", "Anclaje de decisiones: el vínculo entre documentos y grafo", "Contexto al leer + barrera de deriva", "Una decisión activa por tema", "hunch heal + /capture y /heal",
      "Auto-commit seguro para la capa privada", "Conformidad arquitectónica para código de IA", "Control de un vistazo + contexto en todas partes", "Coincidencia de reglas más precisa", "Restricciones por contenido + hooks seguros con symlinks", "Una memoria entre ramas y worktrees", "Memoria fluida entre varias ramas y worktrees",
      "Compatibilidad con Google Antigravity", "Conformidad con la intención", "Captura de intención dentro del código", "hunch compare: veredicto para varios candidatos", "Memoria de procedimientos runbook", "Comprobaciones de deriva de memoria", "Banco de evaluación de recuperación", "Recuperación aumentada con el grafo",
      "Deep Synthesis", "Capa de memoria privada", "Redundancy Guard: esto ya existe", "Veto: protección de decisiones", "Causal Merge Verdict", "Never Twice: las correcciones se convierten en reglas", "CI Constraint Guard", "Disponible en npm + modo strict seguro",
      "Compatibilidad con Windsurf", "Memoria con viaje temporal + Regression Guard", "Hooks de agente + niveles de firmeza", "Síntesis con varios CLI", "Varios asistentes, un solo grafo", "Protecciones en todas partes", "Casi infracciones por radio de impacto", "Reparación de deriva", "Ciclo de aprendizaje de fallos", "Versión inicial"
    ]
  }
};

/** Count the release rows in site/changelog.html.
 *
 *  `changelogLocales[*].titles` maps to those rows POSITIONALLY (generate-site-locales.mjs
 *  consumes them with `copy.titles[titleIndex++]` in row order), so adding a release row
 *  without adding a title to every locale silently shifts every localized title by one.
 *  The generator already refuses to run on a mismatch — but nothing invokes the generator
 *  in tests, CI, or an npm script, so the drift went unnoticed for five releases
 *  (69 rows vs 64 titles) and the localized changelogs simply stopped at v1.9.4.
 *
 *  Exported so the generator and test/changelog-locales.test.ts share ONE definition of a
 *  row instead of each carrying its own regex — a mirrored constant is exactly how this
 *  class of drift starts. A fresh RegExp per call keeps /g lastIndex out of the picture. */
export function countChangelogRows(html) {
  return [...html.matchAll(/<div class="clog-row"><span class="rel-tag">([^<]+)<\/span><span class="clog-t">([\s\S]*?)<\/span><\/div>/g)].length;
}
