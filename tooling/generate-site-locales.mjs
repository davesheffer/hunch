import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blogLocales } from "./blog-locales.mjs";
import { changelogLocales, countChangelogRows } from "./changelog-locales.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "site", "index.html");
const siteOrigin = "https://www.hunchmemory.com";
const normalizeLf = (value) => value.replace(/\r\n?/g, "\n");

const locales = {
  he: {
    dir: "rtl",
    ogLocale: "he_IL",
    title: "Hunch — זיכרון משותף לסוכני AI",
    description: "כל סשן AI מתחיל מאפס. Hunch שומר את ההחלטות, העבודה שהושלמה וההתחייבויות הפתוחות של הצוות — עם מקורות, ב-Git — כדי שהסוכן הבא ימשיך מהנקודה שבה הקודם עצר.",
    ogDescription: "הסוכנים שלכם שוכחים. Hunch זוכר: מה הוחלט, מה בוצע ומה עדיין פתוח — עם מקורות, ב-Git.",
    mainNav: "ניווט ראשי", language: "שפה",
    thesisTag: "מצב דטרמיניסטי", thesisText: "מה זה מצב דטרמיניסטי, במילים פשוטות.", thesisCta: "לקריאת התזה ←",
    navHow: "כך זה עובד", navInside: "מאחורי הקלעים", docs: "תיעוד", blog: "בלוג", changelog: "יומן שינויים",
    getStarted: "מתחילים", seeHow: "כך זה עובד", readDocs: "קריאת התיעוד", benchmark: "מדד ביצועים",
    releaseEyebrow: "Project DNA לעוזרי קוד מבוססי AI", moatEyebrow: "זמין היום", moatTitle: "רשומה אחת. כל סשן. כל סוכן.", moatIntro: "קבצים פשוטים ב-Git. אפשר לעיין בהם בדפדפן או לחבר סוכנים דרך MCP, HTTP, ה-CLI, TypeScript או Python.", moat1Code: "זיכרון", moat1Title: "לשמור את הסיבות", moat1Body: "החלטות, רעיונות שנדחו, באגים ושאלות פתוחות נשמרים לצד הקוד שהם מסבירים.", moat2Code: "החלטות", moat2Title: "בלי סתירות שקטות", moat2Body: "Hunch דוחה שתי החלטות נוכחיות שסותרות זו את זו. מחליפים אחת, וההיסטוריה מראה מה השתנה.", moat3Code: "גישה", moat3Title: "כל סוכן רואה את חלקו", moat3Body: "בוחרים אילו סוכנים יכולים לפתוח כל מרחב, עד לרשומות בודדות. מפתח לכל סוכן מאפשר לחתום על מה שהוא כותב.", moat4Code: "פעולות", moat4Title: "לדעת מה בוצע ומה עוד פתוח", moat4Body: "עבודה שהושלמה, התחייבויות פתוחות והמקורות שלהן במקום אחד. עבודה שאיש לא אימת נשארת מסומנת כלא מאומתת.", moat5Code: "שליטה", moat5Title: "אתם קובעים מה נחשב כלל", moat5Body: "מתעדים איך אתם, הצוות או החברה עובדים. זה נשאר בגדר עצה עד שנותנים אמון בכלל ומפעילים מצב strict.", moat6Code: "git", moat6Title: "הרשומה שלכם, המאגר שלכם", moat6Body: "קבצים קריאים ב-Git. אפשר לסקור שינוי, לבטל אותו ולבנות מחדש את האינדקס בכל עת.", heroTitle: "הסוכנים שלכם שוכחים.<br /><b>Hunch זוכר.</b>",
    heroLede: "כל סשן AI מתחיל מאפס. Hunch שומר מה הצוות החליט, מה בוצע ומה עדיין פתוח — עם מקורות, ב-Git — כדי שהסוכן הבא ימשיך מהנקודה שבה הקודם עצר.",
    heroNote: "לא פרסונה. לא עוד פרומפט. הבנה ניתנת למעקב של הדרך שבה המאגר באמת עובד — עם רמת ביטחון, עדכניות וראיות מצורפות.",
    releaseProofEyebrow: "לראות את הראיות", releaseProofTitle: "לא סומכים על הסוכן. קוראים את הדוח.",
    releaseProofBody: "כל דוח משימה מפריד בין שלושה דברים שרוב הכלים מטשטשים.",
    releaseMetricsAria: "ההבחנות בדוחות משימה", releaseRevision: "נמסר", releaseDeclaration: "מה ש-Hunch מסר לסוכן", releaseConfidence: "דווח", releaseFile: "במה הסוכן אומר שהשתמש", releaseEvidence: "נבדק", releaseInspection: "אילו כללים ופקודות הורצו בפועל",
    releaseCaveat: "בדיקה שעברה אינה מוכיחה לבדה ש-Hunch עזר. אין ראיות, אין טענה — התוצאה נשארת לא מאומתת. <a href=\"/docs#task-reports\">לקריאת דוח משימה →</a>",
    storyEyebrow: "ההקשר החסר", storyTitle: "AI קורא את הקוד. הוא לא היה שם כשהחלטתם.", storyIntro: "הוא רואה מה הקוד עושה — לא למה, מה נשבר בפעם הקודמת, או מה שינוי קטן ישבור בהמשך.",
    monday: "יום שני", monthsLater: "כעבור חודשים", nextSession: "בסשן הבא", withHunch: "עם Hunch",
    story1Title: "הצוות מתקן באג בהתנתקות.", story1Body: "מצב ההתחברות עובר לשרת, כך שמפתח גנוב מפסיק לעבוד ברגע שמתנתקים.",
    story2Title: "הקוד נשאר. הסיבה — לא.", story2Body: "הדיון קבור. הקוד הבטוח נראה עכשיו מסובך מדי.",
    story3Title: "AI ״מסדר״ אותו.", story3Body: "השינוי נראה מושלם. באג ההתנתקות חזר.",
    story4Title: "הסיבה מגיעה קודם.", story4Body: "ברגע שהלקח מתועד, Hunch מציב את ההחלטה — ואת הבאג שהיא מונעת — מול הסוכן לפני שהוא עורך את הקובץ.",
    receiptAria: "דוגמה לזיכרון פרויקט", beforeEditing: "לפני עריכת", memoryFound: "נמצא זיכרון", whyExists: "למה הקוד הזה קיים",
    logoutTitle: "התנתקות חייבת להפסיק את הגישה מיד.", chosen: "נבחר", chosenBody: "לשמור את מצב ההתחברות בשרת, שם אפשר לסיים אותה מיד.",
    rejected: "נדחה", rejectedBody: "לסמוך על אסימון התחברות עד שתוקפו יפוג.",
    protects: "מגן מפני", protectsBody: "שימוש באסימון גנוב אחרי ההתנתקות.", receiptFoot: "זיכרון לדוגמה · המקור מצורף · עצה, לא חסימה",
    watchAria: "הפעלת סרטון: Hunch Memory בשתי דקות", watchCaption: "<b>Hunch Memory בשתי דקות</b> (באנגלית). אחר כך אפשר להעמיק ב<a>סדרה בת 7 פרקים</a>: התקנה, hooks, תיעוד, מסירה, כללים, סחיפה וצוותים.",
    changesEyebrow: "כך Hunch עובד", changesTitle: "לזכור. לשלוף. לבדוק.", changesIntro: "Hunch נותן לסוכן תדריך קצר ודרך לבדוק את עבודתו. את העבודה עצמה הסוכן עדיין עושה.",
    rememberLabel: "01 / לזכור", rememberTitle: "לשמור את מה שלמדנו.", rememberBody: "מתעדים החלטות, תיקונים וממצאים, מקושרים לקוד ולמקור שמהם הגיעו.",
    recallLabel: "02 / לשלוף", recallTitle: "לשלוף בדיוק ברגע הנכון.", recallBody: "כשמשימה מתחילה, Hunch בוחר את הזיכרון הרלוונטי ומוסר אותו דרך MCP או ההוקים של העוזר. מה שמגיע תלוי בעוזר.",
    protectLabel: "03 / לבדוק", protectTitle: "לבדוק, ואז להציג את הדוח.", protectBody: "Hunch מריץ את הכללים שנותנים בהם אמון וכותב דוח משימה: מה נמסר, במה הסוכן השתמש, ומה באמת עבר.",
    underEyebrow: "בתוך כלי הקוד", underTitle: "לדעת מה שינוי ישבור לפני שמבצעים אותו.", underIntro: "בקוד, Hunch מחבר בין הסיבות לבין התלויות ולכללים שהצוות בחר להגן עליהם.",
    savedWithGit: "why", codeGraph: "טווח השפעה", mcpRules: "Project DNA", conformance: "compare", provenance: "conform", localFirst: "בדיקת שינויים",
    gitMemoryTitle: "למצוא את הסיבה", gitMemoryBody: "ההחלטות, הרעיונות שנדחו והכשלים מהעבר שמאחורי כל קובץ או פונקציה.",
    blastTitle: "לראות מה תלוי בו", blastBody: "עוקבים אחרי הקשרים האמיתיים של הקוד כדי לראות עד לאן שינוי יכול להגיע.",
    assistantsTitle: "להכיר את סגנון הבית", assistantsBody: "המינוח וההרגלים ש-Hunch זיהה במאגר הזה. בגדר עצה בלבד.",
    checksTitle: "להשוות אפשרויות", checksBody: "מציבים ענפים מועמדים מול מה שכבר הוחלט.",
    receiptsTitle: "לוודא שהקוד עדיין עומד בהבטחותיו", receiptsBody: "למשל: האם מסלול התשלום עדיין בודק הרשאה?",
    yoursTitle: "להגן על כללים שסומכים עליהם", yoursBody: "מסמן שינויים שמפרים כלל מהימן. מצב strict חוסם רק כשהכלל והעוזר שלכם מאפשרים זאת.",
    shortVersion: "רוצים את הפרטים הטכניים?", explore: "כך Hunch עובד ←",
    startEyebrow: "מתחילים", startTitle: "מתחילים במאגר אחד.",
    installTitle: "התקינו את Hunch", installBody: "מתקינים את ה-CLI ומריצים hunch init בפרויקט שרוצים שיזכור.",
    historyTitle: "ללמד אותו את ההיסטוריה שלכם", historyBody: "אופציונלי: לייבא את החודשים האחרונים מהיסטוריית Git, ואז לסקור מה נלכד.",
    askTitle: "לשאול למה", askBody: "טוענים מחדש את העוזר ושואלים למה קובץ בנוי כך. ב-Codex יש לאשר קודם את ההוקים ב-/hooks.",
    supportedAria: "עוזרים נתמכים", installComment: "# התקנה מ-npm — נדרש Node 22.13+", initComment: "# חיבור Hunch לפרויקט ולעוזרים", backfillComment: "# אפשר ללמוד מ-90 הימים האחרונים", dnaComment: "# בדיקת ה-DNA מבוסס הראיות של המאגר", whyComment: "# לשאול למה קובץ קיים",
    copy: "העתקה", copied: "הועתק", advisoryNote: "Hunch נותן עצה כברירת מחדל — שום דבר לא נחסם עד שמחליטים אחרת. לעדכון, מריצים <code>hunch update</code>, מחברים מחדש את העוזר, וב-Codex סוקרים פקודות שהשתנו ב-<code>/hooks</code>.", pluginPrompt: "משתמשים ב-Claude Code? התקינו במקום זאת כתוסף:",
    ctaTitle: "רשומה אחת, מפנייה של לקוח ועד תיקון מאומת.", ctaBody: "זו המטרה: לקוח מדווח על בעיה, סוכן מתקן את הקוד, וסוכן אחר מוודא שהטיפול הושלם. המצב המשותף זמין היום; הפיילוט של Sofia בודק את ההעברה המלאה.",
    about: "Hunch שומר את ההחלטות, העבודה שהושלמה וההתחייבויות שהסוכנים שלכם צריכים לשתף.",
    product: "מוצר", develop: "פיתוח", connect: "קישורים", mcpTools: "כלי MCP", vscodeExtension: "תוסף ל-VS Code",
    canvasDecision: "החלטה", canvasBug: "באג", canvasRule: "כלל", canvasWhy: "למה", canvasReason: "הסיבה נשלפה לפני העריכה", held: "נשמר", blocked: "נחסם",
  },
  ru: {
    dir: "ltr", ogLocale: "ru_RU",
    title: "Hunch — общая память для ИИ-агентов",
    description: "Каждая сессия ИИ начинается с нуля. Hunch хранит решения вашей команды, выполненную работу и невыполненные обязательства — с источниками, в Git, — чтобы следующий агент продолжил с того места, где остановился предыдущий.",
    ogDescription: "Ваши агенты забывают. Hunch помнит: что решили, что сделали и что ещё должны — с источниками, в Git.",
    mainNav: "Основная навигация", language: "Язык",
    thesisTag: "Детерминированное состояние", thesisText: "Что такое детерминированное состояние, простыми словами.", thesisCta: "Читать тезис →",
    navHow: "Как это работает", navInside: "Что внутри", docs: "Документация", blog: "Блог", changelog: "История изменений",
    getStarted: "Начать", seeHow: "Посмотреть, как это работает", readDocs: "Читать документацию", benchmark: "Бенчмарк",
    releaseEyebrow: "ДНК проекта для ИИ-агентов по коду", moatEyebrow: "доступно сегодня", moatTitle: "Одна запись. Каждая сессия. Каждый агент.", moatIntro: "Обычные файлы в Git. Просматривайте их в браузере или подключайте агентов через MCP, HTTP, CLI, TypeScript или Python.", moat1Code: "память", moat1Title: "Сохраняйте причины", moat1Body: "Решения, отвергнутые идеи, ошибки и открытые вопросы лежат рядом с кодом, который они объясняют.", moat2Code: "решения", moat2Title: "Никаких тихих противоречий", moat2Body: "Hunch не принимает два действующих решения, которые конфликтуют. Замените одно — и история покажет, что изменилось.", moat3Code: "доступ", moat3Title: "Каждый агент видит свою часть", moat3Body: "Выбирайте, какие агенты могут открывать каждый раздел, вплоть до отдельных записей. Добавьте ключ для каждого агента, чтобы подписывать его записи.", moat4Code: "действия", moat4Title: "Знайте, что сделано и что за вами", moat4Body: "Выполненная работа, открытые обязательства и их источники — в одном месте. Непроверенная работа так и остаётся помеченной как непроверенная.", moat5Code: "контроль", moat5Title: "Вы решаете, что считать правилом", moat5Body: "Записывайте, как принято у вас, в вашей команде или компании. Это остаётся рекомендацией, пока вы не доверите правило и не включите строгий режим.", moat6Code: "git", moat6Title: "Ваша запись, ваш репозиторий", moat6Body: "Читаемые файлы в Git. Проверьте изменение, откатите его, перестройте индекс в любой момент.", heroTitle: "Ваши агенты забывают.<br /><b>Hunch помнит.</b>",
    heroLede: "Каждая сессия ИИ начинается с нуля. Hunch хранит то, что решила команда, что сделано и что ещё за вами, — с источниками, в Git, — чтобы следующий агент продолжил с того места, где остановился предыдущий.",
    heroNote: "Не персона. Не ещё один промпт. Прослеживаемое понимание того, как на самом деле работает ваш репозиторий, — с уверенностью, актуальностью и приложенными доказательствами.",
    releaseProofEyebrow: "смотрите подтверждения", releaseProofTitle: "Не верьте агенту на слово. Читайте отчёт.",
    releaseProofBody: "В каждом отчёте о задаче раздельно лежат три вещи, которые большинство инструментов смешивает.",
    releaseMetricsAria: "Что различают отчёты о задачах", releaseRevision: "передано", releaseDeclaration: "что Hunch передал агенту", releaseConfidence: "заявлено", releaseFile: "что агент, по его словам, использовал", releaseEvidence: "проверено", releaseInspection: "какие правила и команды реально выполнялись",
    releaseCaveat: "Один зелёный тест не доказывает, что помог Hunch. Нет свидетельств — нет заявления: результат остаётся непроверенным. <a href=\"/docs#task-reports\">Читать отчёт о задаче →</a>",
    storyEyebrow: "недостающий контекст", storyTitle: "ИИ читает ваш код. Но его не было рядом, когда вы решали.", storyIntro: "Он видит, что делает код, но не знает почему, что ломалось раньше и что сломает небольшая правка.",
    monday: "Понедельник", monthsLater: "Через несколько месяцев", nextSession: "Следующий сеанс", withHunch: "С Hunch",
    story1Title: "Команда исправляет ошибку выхода из аккаунта.", story1Body: "Вход переносят на сервер, чтобы украденный ключ переставал работать сразу после выхода из аккаунта.",
    story2Title: "Код остаётся. Причина теряется.", story2Body: "Обсуждение похоронено. Безопасный код теперь выглядит излишне сложным.",
    story3Title: "ИИ «наводит порядок».", story3Body: "Диф выглядит отлично. Ошибка с выходом из аккаунта возвращается.",
    story4Title: "Причина появляется первой.", story4Body: "Когда урок записан, Hunch показывает агенту решение — и ошибку, которую оно предотвращает, — до правки файла.",
    receiptAria: "Пример памяти проекта", beforeEditing: "перед изменением", memoryFound: "память найдена", whyExists: "Почему существует этот код",
    logoutTitle: "Выход из аккаунта должен сразу прекращать доступ.", chosen: "выбрано", chosenBody: "Хранить данные о входе на сервере, где доступ можно сразу прекратить.",
    rejected: "отвергнуто", rejectedBody: "Доверять токену входа до истечения его срока действия.",
    protects: "защищает от", protectsBody: "Использования украденного токена после выхода из аккаунта.", receiptFoot: "пример памяти · источник приложен · рекомендация, не блокировка",
    watchAria: "Воспроизвести видео: Hunch Memory за 2 минуты", watchCaption: "<b>Hunch Memory за 2 минуты</b> (на английском). Дальше — <a>серия из 7 эпизодов</a>: установка, хуки, запись, доставка, правила, дрейф и команды.",
    changesEyebrow: "Как работает Hunch", changesTitle: "Помнить. Находить. Проверять.", changesIntro: "Hunch даёт агенту краткую справку и способ проверить свою работу. Саму работу по-прежнему делает агент.",
    rememberLabel: "01 / помнить", rememberTitle: "Сохраняйте то, что узнали.", rememberBody: "Записывайте решения, исправления и находки — со ссылками на код и источник, откуда они взялись.",
    recallLabel: "02 / находить", recallTitle: "Возвращайте в нужный момент.", recallBody: "Когда задача начинается, Hunch выбирает важную память и доставляет её через MCP или хуки вашего помощника. Что именно дойдёт, зависит от помощника.",
    protectLabel: "03 / проверять", protectTitle: "Проверьте и покажите отчёт.", protectBody: "Hunch запускает правила, которым вы доверяете, и пишет отчёт о задаче: что он передал, что использовал агент, что реально прошло проверку.",
    underEyebrow: "в инструментах для кода", underTitle: "Узнайте, что сломает изменение, до того как внесёте его.", underIntro: "Для кода Hunch связывает причины с зависимостями и с правилами, которые ваша команда решила защищать.",
    savedWithGit: "why", codeGraph: "область влияния", mcpRules: "Project DNA", conformance: "compare", provenance: "conform", localFirst: "проверка изменений",
    gitMemoryTitle: "Найдите причину", gitMemoryBody: "Решения, отвергнутые идеи и прошлые сбои за любым файлом или функцией.",
    blastTitle: "Узнайте, что от него зависит", blastBody: "Проследите реальные связи в коде и увидите, до чего может дотянуться изменение.",
    assistantsTitle: "Освойте стиль проекта", assistantsBody: "Смотрите термины и привычки, которые Hunch заметил в этом репозитории. Только рекомендации.",
    checksTitle: "Сравнивайте варианты", checksBody: "Сопоставьте ветки-кандидаты с тем, что вы уже решили.",
    receiptsTitle: "Проверьте, что код держит свои обещания", receiptsBody: "Например: проверяет ли путь оплаты по-прежнему полномочия?",
    yoursTitle: "Защищайте правила, которым доверяете", yoursBody: "Отмечает изменения, нарушающие доверенное правило. Строгий режим блокирует только там, где это допускают правило и ваш помощник.",
    shortVersion: "Нужны технические подробности?", explore: "Как работает Hunch →",
    startEyebrow: "начало работы", startTitle: "Начните с одного репозитория.",
    installTitle: "Установите Hunch", installBody: "Установите CLI и запустите hunch init в проекте, который Hunch должен помнить.",
    historyTitle: "Расскажите ему свою историю", historyBody: "По желанию: загрузите последние месяцы Git и проверьте, что он записал.",
    askTitle: "Спросите, почему", askBody: "Перезапустите помощника и спросите, почему файл устроен именно так. Используете Codex? Сначала доверьте хуки в /hooks.",
    supportedAria: "Поддерживаемые помощники", installComment: "# установка из npm — требуется Node 22.13+", initComment: "# подключить Hunch к проекту и помощникам", backfillComment: "# при желании изучить последние 90 дней", dnaComment: "# изучить доказательную ДНК репозитория", whyComment: "# спросить, зачем нужен файл",
    copy: "копировать", copied: "скопировано", advisoryNote: "По умолчанию Hunch лишь советует — ничто не блокируется, пока вы сами этого не решите. Чтобы обновиться, запустите <code>hunch update</code>, переподключите помощника, а в Codex проверьте изменённые команды в <code>/hooks</code>.", pluginPrompt: "Используете Claude Code? Установите плагин:",
    ctaTitle: "Одна запись — от обращения клиента до проверенного исправления.", ctaBody: "Такова цель: клиент сообщает о проблеме, один агент чинит код, другой подтверждает, что готово. Общее состояние уже работает; пилот Sofia проверяет передачу целиком.",
    about: "Hunch хранит решения, выполненную работу и обязательства, которые нужны вашим агентам сообща.",
    product: "продукт", develop: "разработка", connect: "ссылки", mcpTools: "Инструменты MCP", vscodeExtension: "Расширение VS Code",
    canvasDecision: "решение", canvasBug: "ошибка", canvasRule: "правило", canvasWhy: "почему", canvasReason: "причина найдена до правки", held: "сохранено", blocked: "заблокировано",
  },
  ar: {
    dir: "rtl", ogLocale: "ar",
    title: "Hunch — ذاكرة مشتركة لوكلاء الذكاء الاصطناعي",
    description: "كل جلسة ذكاء اصطناعي تبدأ من الصفر. يحفظ Hunch قرارات فريقك والعمل المنجز والالتزامات المفتوحة — مع مصادرها، داخل Git — ليكمل الوكيل التالي من حيث توقّف السابق.",
    ogDescription: "وكلاؤك ينسون. وHunch يتذكّر: ما تقرّر، وما أُنجز، وما لا يزال مستحقًا — مع المصادر، داخل Git.",
    mainNav: "التنقّل الرئيسي", language: "اللغة",
    thesisTag: "الحالة الحتمية", thesisText: "ما معنى الحالة الحتمية، بكلمات بسيطة.", thesisCta: "اقرأ الأطروحة ←",
    navHow: "كيف يعمل", navInside: "ما وراء الواجهة", docs: "الوثائق", blog: "المدوّنة", changelog: "سجل التغييرات",
    getStarted: "ابدأ الآن", seeHow: "شاهد كيف يعمل", readDocs: "اقرأ الوثائق", benchmark: "اختبار الأداء",
    releaseEyebrow: "الحمض النووي للمشروع لوكلاء البرمجة بالذكاء الاصطناعي", moatEyebrow: "متاح اليوم", moatTitle: "سجل واحد. كل جلسة. كل وكيل.", moatIntro: "ملفات عادية في Git. تصفّحها في المتصفح، أو صِل الوكلاء عبر MCP أو HTTP أو سطر الأوامر أو TypeScript أو Python.", moat1Code: "الذاكرة", moat1Title: "احتفظ بالأسباب", moat1Body: "القرارات والأفكار المرفوضة والأخطاء والأسئلة المفتوحة تعيش إلى جانب الشيفرة التي تشرحها.", moat2Code: "القرارات", moat2Title: "لا تناقضات صامتة", moat2Body: "يرفض Hunch قرارين حاليين متعارضين. استبدل أحدهما، ويُظهر السجل ما تغيّر.", moat3Code: "الوصول", moat3Title: "كل وكيل يرى نصيبه", moat3Body: "اختر الوكلاء المسموح لهم بفتح كل قسم، وصولًا إلى سجلات بعينها. وأضف مفتاحًا لكل وكيل لتوقيع ما يكتبه.", moat4Code: "الإجراءات", moat4Title: "اعرف ما أُنجز وما هو مستحق", moat4Body: "شاهد العمل المنجز والالتزامات المفتوحة ومصادرها في مكان واحد. والعمل الذي لم يتحقق منه أحد يبقى موسومًا بأنه غير متحقق منه.", moat5Code: "التحكم", moat5Title: "أنت تقرّر ما يصير قاعدة", moat5Body: "سجّل طريقة عملك أو عمل فريقك أو شركتك. يبقى إرشادًا إلى أن تثق بقاعدة وتفعّل الوضع الصارم.", moat6Code: "git", moat6Title: "سجلّك، ومستودعك", moat6Body: "ملفات مقروءة في Git. راجع أي تغيير، وتراجع عنه، وأعد بناء الفهرس متى شئت.", heroTitle: "وكلاؤك ينسون.<br /><b>Hunch يتذكّر.</b>",
    heroLede: "كل جلسة ذكاء اصطناعي تبدأ من الصفر. يحفظ Hunch ما قرّره فريقك وما أُنجز وما لا يزال مستحقًا — مع المصادر، داخل Git — ليكمل الوكيل التالي من حيث توقّف السابق.",
    heroNote: "ليس شخصية مصطنعة. وليس مطالبة أخرى. بل فهم قابل للتتبّع لكيفية عمل مستودعك فعلًا، مرفق بدرجة الثقة والحداثة والأدلة.",
    releaseProofEyebrow: "اطّلع على الأدلة", releaseProofTitle: "لا تثق بالوكيل. اقرأ الإيصال.",
    releaseProofBody: "يفصل كل تقرير مهمة بين ثلاثة أمور تخلط بينها معظم الأدوات.",
    releaseMetricsAria: "ما تميّز بينه تقارير المهام", releaseRevision: "مقدّم", releaseDeclaration: "ما سلّمه Hunch للوكيل", releaseConfidence: "مُبلّغ عنه", releaseFile: "ما يقول الوكيل إنه استخدمه", releaseEvidence: "مفحوص", releaseInspection: "القواعد والأوامر التي نُفّذت فعلًا",
    releaseCaveat: "نجاح اختبار وحده لا يثبت أن Hunch أفاد. لا دليل، لا ادّعاء — ويبقى غير متحقق منه. <a href=\"/docs#task-reports\">اقرأ تقرير مهمة →</a>",
    storyEyebrow: "السياق المفقود", storyTitle: "الذكاء الاصطناعي يقرأ شيفرتك. لكنه لم يكن حاضرًا حين اتُّخذ القرار.", storyIntro: "يرى ما تفعله الشيفرة، لا لماذا، ولا ما انكسر في المرة السابقة، ولا ما سيكسره تغيير صغير لاحقًا.",
    monday: "يوم الاثنين", monthsLater: "بعد أشهر", nextSession: "الجلسة التالية", withHunch: "مع Hunch",
    story1Title: "يصلح الفريق خطأً في تسجيل الخروج.", story1Body: "ينتقل تسجيل الدخول إلى الخادم، فيتوقف المفتاح المسروق عن العمل لحظة تسجيل الخروج.",
    story2Title: "تبقى الشيفرة. ويضيع السبب.", story2Body: "النقاش مدفون. والشيفرة الآمنة تبدو الآن معقّدة بلا داعٍ.",
    story3Title: "ذكاء اصطناعي «ينظّف» الشيفرة.", story3Body: "التغيير يبدو رائعًا. وخطأ تسجيل الخروج يعود.",
    story4Title: "السبب يصل أولًا.", story4Body: "متى سُجّل الدرس، يضع Hunch القرار — والخطأ الذي يمنعه — أمام الوكيل قبل أن يعدّل الملف.",
    receiptAria: "مثال على ذاكرة المشروع", beforeEditing: "قبل تعديل", memoryFound: "عُثر على ذاكرة", whyExists: "لماذا توجد هذه الشيفرة",
    logoutTitle: "يجب أن ينهي تسجيل الخروج الوصول فورًا.", chosen: "المختار", chosenBody: "الاحتفاظ بحالة تسجيل الدخول على الخادم، حيث يمكن إنهاؤها فورًا.",
    rejected: "المرفوض", rejectedBody: "الثقة برمز تسجيل الدخول حتى تنتهي صلاحيته.",
    protects: "يحمي من", protectsBody: "استخدام رمز مسروق بعد تسجيل الخروج.", receiptFoot: "ذاكرة توضيحية · المصدر مرفق · إرشاد لا حظر",
    watchAria: "تشغيل الفيديو: Hunch Memory في دقيقتين", watchCaption: "<b>Hunch Memory في دقيقتين</b> (بالإنجليزية). ثم تعمّق في <a>سلسلة من 7 حلقات</a>: الإعداد، والخطافات، والتسجيل، والتسليم، والقواعد، والانحراف، والفرق.",
    changesEyebrow: "كيف يعمل Hunch", changesTitle: "تذكّر. استرجع. تحقّق.", changesIntro: "يمنح Hunch الوكيل ملخصًا قصيرًا وطريقة للتحقق من عمله. أما العمل نفسه فيبقى على الوكيل.",
    rememberLabel: "01 / تذكّر", rememberTitle: "احفظ ما تعلّمته.", rememberBody: "سجّل القرارات والتصحيحات والملاحظات، مرتبطة بالشيفرة والمصدر الذي جاءت منه.",
    recallLabel: "02 / استرجع", recallTitle: "استعده في اللحظة المناسبة.", recallBody: "عند بدء المهمة، يختار Hunch الذاكرة المهمة ويسلّمها عبر MCP أو خطافات مساعدك. ما يصل يعتمد على المساعد.",
    protectLabel: "03 / تحقّق", protectTitle: "تحقّق، ثم اعرض الإيصال.", protectBody: "ينفّذ Hunch القواعد التي تثق بها ويكتب تقرير مهمة: ما سلّمه، وما استخدمه الوكيل، وما نجح فعلًا.",
    underEyebrow: "داخل أدوات البرمجة", underTitle: "اعرف ما سيكسره التغيير قبل أن تجريه.", underIntro: "في الشيفرة، يربط Hunch الأسباب بالاعتماديات وبالقواعد التي اختار فريقك حمايتها.",
    savedWithGit: "why", codeGraph: "نطاق التأثير", mcpRules: "Project DNA", conformance: "compare", provenance: "conform", localFirst: "بوابة التغييرات",
    gitMemoryTitle: "اعثر على السبب", gitMemoryBody: "القرارات والأفكار المرفوضة والإخفاقات السابقة وراء أي ملف أو دالة.",
    blastTitle: "اعرف ما يعتمد عليه", blastBody: "تتبّع الروابط الفعلية في الشيفرة لتعرف إلى أين يمكن أن يصل التغيير.",
    assistantsTitle: "تعرّف على أسلوب المشروع", assistantsBody: "اطّلع على المصطلحات والعادات التي رصدها Hunch في هذا المستودع. إرشاد فقط.",
    checksTitle: "قارن الخيارات", checksBody: "ضع الفروع المرشحة أمام ما قرّرته سابقًا.",
    receiptsTitle: "تحقّق أن الشيفرة لا تزال تفي بوعودها", receiptsBody: "مثلًا: هل لا يزال مسار الدفع يتحقق من الصلاحيات؟",
    yoursTitle: "احمِ القواعد التي تثق بها", yoursBody: "ينبّه إلى التغييرات التي تخالف قاعدة موثوقة. ولا يحظر الوضع الصارم إلا حيث تسمح القاعدة ومساعدك بذلك.",
    shortVersion: "هل تريد التفاصيل التقنية؟", explore: "اقرأ كيف يعمل Hunch ←",
    startEyebrow: "ابدأ", startTitle: "ابدأ من مستودع واحد.",
    installTitle: "ثبّت Hunch", installBody: "ثبّت أداة CLI، ثم شغّل hunch init داخل المشروع الذي تريد أن يتذكّره.",
    historyTitle: "علّمه تاريخك", historyBody: "اختياري: املأ الذاكرة من آخر أشهر في Git، ثم راجع ما التقطه.",
    askTitle: "اسأل لماذا", askBody: "أعد تحميل المساعد واسأله لماذا بُني ملف بهذه الطريقة. تستخدم Codex؟ أكّد الثقة بالخطافات أولًا عبر /hooks.",
    supportedAria: "المساعدون المدعومون", installComment: "# التثبيت من npm — يتطلب Node 22.13+", initComment: "# ربط Hunch بالمشروع والمساعدين", backfillComment: "# تعلّم اختياري من آخر 90 يومًا", dnaComment: "# افحص الحمض النووي القائم على أدلة المستودع", whyComment: "# اسأل عن سبب وجود ملف",
    copy: "نسخ", copied: "تم النسخ", advisoryNote: "يقدّم Hunch الإرشاد افتراضيًا — ولا يُحظر شيء حتى تقرّر. للتحديث، شغّل <code>hunch update</code>، وأعد ربط المساعد، وفي Codex راجع الأوامر التي تغيّرت في <code>/hooks</code>.", pluginPrompt: "تستخدم Claude Code؟ ثبّته كإضافة بدلًا من ذلك:",
    ctaTitle: "سجل واحد، من شكوى العميل إلى إصلاح متحقق منه.", ctaBody: "هذا هو الهدف: عميل يبلّغ عن مشكلة، ووكيل يصلح الشيفرة، وآخر يؤكد إنجاز العمل. الحالة المشتركة متاحة اليوم؛ ويختبر مشروع Sofia التجريبي انتقال العمل كاملًا.",
    about: "يحفظ Hunch القرارات والعمل المنجز والالتزامات التي يحتاج وكلاؤك إلى مشاركتها.",
    product: "المنتج", develop: "التطوير", connect: "روابط", mcpTools: "أدوات MCP", vscodeExtension: "إضافة VS Code",
    canvasDecision: "قرار", canvasBug: "خطأ", canvasRule: "قاعدة", canvasWhy: "لماذا", canvasReason: "استُعيد السبب قبل التعديل", held: "محفوظ", blocked: "محظور",
  },
  es: {
    dir: "ltr", ogLocale: "es_ES",
    title: "Hunch — Memoria compartida para agentes de IA",
    description: "Cada sesión de IA empieza de cero. Hunch guarda las decisiones de tu equipo, el trabajo terminado y los compromisos abiertos — con sus fuentes, en Git — para que el siguiente agente retome justo donde lo dejó el anterior.",
    ogDescription: "Tus agentes olvidan. Hunch recuerda: lo que se decidió, lo que se hizo y lo que aún se debe — con fuentes, en Git.",
    mainNav: "Navegación principal", language: "Idioma",
    thesisTag: "Estado determinista", thesisText: "Qué significa estado determinista, en palabras sencillas.", thesisCta: "Leer la tesis →",
    navHow: "Cómo funciona", navInside: "Cómo está hecho", docs: "Documentación", blog: "Blog", changelog: "Cambios",
    getStarted: "Empezar", seeHow: "Ver cómo funciona", readDocs: "Leer la documentación", benchmark: "Benchmark",
    releaseEyebrow: "ADN del proyecto para agentes de programación con IA", moatEyebrow: "disponible hoy", moatTitle: "Un solo registro. Cada sesión. Cada agente.", moatIntro: "Archivos simples en Git. Explóralos en el navegador o conecta agentes por MCP, HTTP, la CLI, TypeScript o Python.", moat1Code: "memoria", moat1Title: "Conserva los motivos", moat1Body: "Decisiones, ideas descartadas, errores y preguntas abiertas viven junto al código que explican.", moat2Code: "decisiones", moat2Title: "Sin contradicciones silenciosas", moat2Body: "Hunch rechaza dos decisiones vigentes que choquen. Reemplaza una y el historial muestra qué cambió.", moat3Code: "acceso", moat3Title: "Cada agente ve su parte", moat3Body: "Elige qué agentes pueden abrir cada espacio, hasta registros individuales. Añade una clave por agente para firmar lo que escribe.", moat4Code: "acciones", moat4Title: "Sabe qué está hecho y qué se debe", moat4Body: "Mira el trabajo terminado, los compromisos abiertos y sus fuentes en un solo lugar. Lo que nadie verificó sigue marcado como no verificado.", moat5Code: "control", moat5Title: "Tú decides qué es una regla", moat5Body: "Registra cómo trabajas tú, tu equipo o tu empresa. Sigue siendo un consejo hasta que confíes en una regla y actives el modo estricto.", moat6Code: "git", moat6Title: "Tu registro, tu repositorio", moat6Body: "Archivos legibles en Git. Revisa un cambio, revíertelo, reconstruye el índice cuando quieras.", heroTitle: "Tus agentes olvidan.<br /><b>Hunch recuerda.</b>",
    heroLede: "Cada sesión de IA empieza de cero. Hunch guarda lo que tu equipo decidió, lo que se hizo y lo que aún se debe — con fuentes, en Git — para que el siguiente agente retome justo donde lo dejó el anterior.",
    heroNote: "No es una personalidad. No es otro prompt. Es una comprensión trazable de cómo funciona de verdad tu repositorio, con confianza, vigencia y evidencia adjuntas.",
    releaseProofEyebrow: "consulta las pruebas", releaseProofTitle: "No confíes en el agente. Lee el recibo.",
    releaseProofBody: "Cada informe de tarea separa tres cosas que la mayoría de las herramientas mezclan.",
    releaseMetricsAria: "Qué distinguen los informes de tarea", releaseRevision: "entregado", releaseDeclaration: "lo que Hunch entregó al agente", releaseConfidence: "declarado", releaseFile: "lo que el agente dice haber usado", releaseEvidence: "comprobado", releaseInspection: "qué reglas y comandos se ejecutaron realmente",
    releaseCaveat: "Una prueba verde por sí sola no demuestra que Hunch ayudara. Sin pruebas, no hay afirmación: sigue sin verificar. <a href=\"/docs#task-reports\">Lee un informe de tarea →</a>",
    storyEyebrow: "el contexto que falta", storyTitle: "La IA lee tu código. No estaba ahí cuando se decidió.", storyIntro: "Ve lo que hace el código, pero no el porqué, qué falló la última vez ni qué romperá un cambio pequeño.",
    monday: "Lunes", monthsLater: "Meses después", nextSession: "Siguiente sesión", withHunch: "Con Hunch",
    story1Title: "Tu equipo corrige un error al cerrar sesión.", story1Body: "El inicio de sesión pasa al servidor, así que una clave robada muere en cuanto alguien cierra sesión.",
    story2Title: "El código se queda. La razón no.", story2Body: "La discusión queda enterrada. El código seguro ahora solo parece complicado de más.",
    story3Title: "Una IA lo “limpia”.", story3Body: "El diff se ve genial. El error del cierre de sesión vuelve.",
    story4Title: "Primero llega la razón.", story4Body: "Una vez registrada la lección, Hunch pone la decisión — y el error que evita — delante del agente antes de que edite el archivo.",
    receiptAria: "Ejemplo de memoria del proyecto", beforeEditing: "antes de editar", memoryFound: "memoria encontrada", whyExists: "Por qué existe este código",
    logoutTitle: "Cerrar sesión debe poner fin al acceso de inmediato.", chosen: "elegido", chosenBody: "Guardar las sesiones en el servidor, donde pueden cerrarse al instante.",
    rejected: "descartado", rejectedBody: "Confiar en un token de acceso hasta que caduque.",
    protects: "protege de", protectsBody: "El uso de un token robado después de cerrar sesión.", receiptFoot: "memoria de ejemplo · con fuente adjunta · un consejo, no un bloqueo",
    watchAria: "Reproducir vídeo: Hunch Memory en 2 minutos", watchCaption: "<b>Hunch Memory en 2 minutos</b> (en inglés). Después, profundiza en la <a>serie de 7 episodios</a>: instalación, hooks, captura, entrega, reglas, deriva y equipos.",
    changesEyebrow: "Cómo funciona Hunch", changesTitle: "Recordar. Recuperar. Comprobar.", changesIntro: "Hunch le da al agente un resumen breve y una forma de comprobar su trabajo. El trabajo lo sigue haciendo el agente.",
    rememberLabel: "01 / recordar", rememberTitle: "Guarda lo que aprendiste.", rememberBody: "Registra decisiones, correcciones y hallazgos, vinculados al código y a la fuente de la que salieron.",
    recallLabel: "02 / recuperar", recallTitle: "Tráelo en el momento justo.", recallBody: "Al empezar una tarea, Hunch elige la memoria que importa y la entrega por MCP o por los hooks de tu asistente. Lo que llega depende del asistente.",
    protectLabel: "03 / comprobar", protectTitle: "Comprueba y enseña el recibo.", protectBody: "Hunch ejecuta las reglas en las que confías y escribe un informe de tarea: qué entregó, qué usó el agente, qué pasó de verdad.",
    underEyebrow: "dentro de las herramientas de código", underTitle: "Sabe qué rompe un cambio antes de hacerlo.", underIntro: "En el código, Hunch conecta las razones con las dependencias y con las reglas que tu equipo eligió proteger.",
    savedWithGit: "why", codeGraph: "alcance del cambio", mcpRules: "Project DNA", conformance: "compare", provenance: "conform", localFirst: "control de cambios",
    gitMemoryTitle: "Encuentra el motivo", gitMemoryBody: "Decisiones, ideas descartadas y fallos pasados detrás de cualquier archivo o función.",
    blastTitle: "Mira qué depende de él", blastBody: "Sigue las conexiones reales del código para ver hasta dónde llega un cambio.",
    assistantsTitle: "Aprende el estilo de la casa", assistantsBody: "Mira los términos y hábitos que Hunch observó en este repositorio. Solo como consejo.",
    checksTitle: "Compara opciones", checksBody: "Contrasta las ramas candidatas con lo que ya decidiste.",
    receiptsTitle: "Verifica que el código sigue cumpliendo sus promesas", receiptsBody: "Por ejemplo: ¿la ruta de pago sigue comprobando la autorización?",
    yoursTitle: "Protege las reglas en las que confías", yoursBody: "Señala los cambios que rompen una regla de confianza. El modo estricto solo bloquea donde esa regla y tu asistente lo permiten.",
    shortVersion: "¿Quieres los detalles técnicos?", explore: "Lee cómo funciona Hunch →",
    startEyebrow: "primeros pasos", startTitle: "Empieza en un solo repositorio.",
    installTitle: "Instala Hunch", installBody: "Instala la CLI y ejecuta hunch init en el proyecto que quieras que recuerde.",
    historyTitle: "Enséñale tu historia", historyBody: "Opcional: reconstruye los últimos meses de Git y revisa lo que capturó.",
    askTitle: "Pregunta por qué", askBody: "Recarga tu asistente y pregunta por qué un archivo está hecho así. ¿Usas Codex? Confía primero en los hooks desde /hooks.",
    supportedAria: "Asistentes compatibles", installComment: "# instalación desde npm — requiere Node 22.13+", initComment: "# conecta Hunch al proyecto y a tus asistentes", backfillComment: "# aprende opcionalmente de los últimos 90 días", dnaComment: "# inspecciona el ADN del repositorio basado en evidencia", whyComment: "# pregunta para qué sirve un archivo",
    copy: "copiar", copied: "copiado", advisoryNote: "Hunch aconseja por defecto: nada se bloquea hasta que tú lo decidas. Para actualizar, ejecuta <code>hunch update</code>, vuelve a conectar el asistente y, en Codex, revisa los comandos que hayan cambiado en <code>/hooks</code>.", pluginPrompt: "¿Usas Claude Code? Instálalo como plugin:",
    ctaTitle: "Un solo registro, de la incidencia del cliente a la corrección verificada.", ctaBody: "Ese es el objetivo: un cliente reporta un problema, un agente corrige el código, otro confirma que está resuelto. El estado compartido ya está disponible; el piloto de Sofia prueba el traspaso completo.",
    about: "Hunch guarda las decisiones, el trabajo terminado y los compromisos que tus agentes necesitan compartir.",
    product: "producto", develop: "desarrollo", connect: "enlaces", mcpTools: "Herramientas MCP", vscodeExtension: "Extensión de VS Code",
    canvasDecision: "decisión", canvasBug: "error", canvasRule: "regla", canvasWhy: "por qué", canvasReason: "razón recuperada antes de editar", held: "conservado", blocked: "bloqueado",
  },
};

function escAttr(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function fragments(c) {
  return [
    ["<title>Hunch — Shared memory for AI agents</title>", `<title>${c.title}</title>`],
    ["content=\"Every AI session starts from zero. Hunch keeps your team’s decisions, finished work and open commitments — with sources, in Git — so the next agent picks up where the last one left off.\"", `content="${escAttr(c.description)}"`],
    ["<meta property=\"og:title\" content=\"Hunch — Shared memory for AI agents\" />", `<meta property="og:title" content="${escAttr(c.title)}" />`],
    ["content=\"Your agents forget. Hunch remembers: what was decided, what got done and what’s still owed — with sources, in Git.\"", `content="${escAttr(c.ogDescription)}"`],
    ['<span class="thesis-tag">Deterministic State</span>', `<span class="thesis-tag">${c.thesisTag}</span>`],
    ['<span class="thesis-text">What deterministic state means, in plain words.</span>', `<span class="thesis-text">${c.thesisText}</span>`],
    ['<b class="thesis-cta">Read the thesis →</b>', `<b class="thesis-cta">${c.thesisCta}</b>`],
    ['<nav class="nav" aria-label="Main">', `<nav class="nav" aria-label="${escAttr(c.mainNav)}">`],
    ['<span class="sr-only">Language</span>', `<span class="sr-only">${c.language}</span>`],
    ['aria-label="Language"', `aria-label="${escAttr(c.language)}"`],
    [">How it works<", `>${c.navHow}<`], [">Under the hood<", `>${c.navInside}<`], [">Docs<", `>${c.docs}<`], [">Blog<", `>${c.blog}<`], [">Changelog<", `>${c.changelog}<`],
    [">Get started<", `>${c.getStarted}<`], [">See how it works<", `>${c.seeHow}<`], [">Read the docs<", `>${c.readDocs}<`], [">Benchmark<", `>${c.benchmark}<`],
    ["<h1 class=\"rise d1\">Your agents forget.<br /><b>Hunch remembers.</b></h1>", `<h1 class="rise d1">${c.heroTitle}</h1>`],
    ["<p class=\"lede rise d2\">Every AI session starts from zero. Hunch keeps what your team decided, what got done and what’s still owed — with sources, in Git — so the next agent picks up where the last one left off.</p>", `<p class="lede rise d2">${c.heroLede}</p>`],
    ["<span class=\"eyebrow\">available today</span>", `<span class="eyebrow">${c.moatEyebrow}</span>`], ["<h2>One record. Every session. Every agent.</h2>", `<h2>${c.moatTitle}</h2>`],
    ["<p>Plain files in Git. Browse them in your browser, or plug agents in through MCP, HTTP, the CLI, TypeScript or Python.</p>", `<p>${c.moatIntro}</p>`],
    ['aria-label="Play video: Hunch Memory in 2 minutes"', `aria-label="${escAttr(c.watchAria)}"`],
    ['<figcaption><b>Hunch Memory in 2 minutes.</b> Then go deeper in the <a href="https://www.youtube.com/playlist?list=PLIXqtdE0LcNI" target="_blank" rel="noopener">7-episode series</a>: setup, hooks, capture, delivery, rules, drift and teams.</figcaption>', `<figcaption>${c.watchCaption.replace("<a>", '<a href="https://www.youtube.com/playlist?list=PLIXqtdE0LcNI" target="_blank" rel="noopener">')}</figcaption>`],
    ["<article class=\"tech-item\"><code>memory</code><h3>Keep the reasons</h3><p>Decisions, rejected ideas, bugs and open questions live next to the code they explain.</p></article>", `<article class="tech-item"><code>${c.moat1Code}</code><h3>${c.moat1Title}</h3><p>${c.moat1Body}</p></article>`],
    ["<article class=\"tech-item\"><code>decisions</code><h3>No silent contradictions</h3><p>Hunch refuses two current decisions that conflict. Replace one, and the history shows what changed.</p></article>", `<article class="tech-item"><code>${c.moat2Code}</code><h3>${c.moat2Title}</h3><p>${c.moat2Body}</p></article>`],
    ["<article class=\"tech-item\"><code>access</code><h3>Each agent sees its share</h3><p>Pick which agents can open each space, down to single records. Add a key per agent to sign what it writes.</p></article>", `<article class="tech-item"><code>${c.moat3Code}</code><h3>${c.moat3Title}</h3><p>${c.moat3Body}</p></article>`],
    ["<article class=\"tech-item\"><code>actions</code><h3>Know what’s done and what’s owed</h3><p>See finished work, open commitments and their sources in one place. Work nobody verified stays marked unverified.</p></article>", `<article class="tech-item"><code>${c.moat4Code}</code><h3>${c.moat4Title}</h3><p>${c.moat4Body}</p></article>`],
    ["<article class=\"tech-item\"><code>control</code><h3>You decide what’s a rule</h3><p>Record how you, your team or your company does things. It stays advice until you trust a rule and turn on strict mode.</p></article>", `<article class="tech-item"><code>${c.moat5Code}</code><h3>${c.moat5Title}</h3><p>${c.moat5Body}</p></article>`],
    ["<article class=\"tech-item\"><code>git</code><h3>Your record, your repo</h3><p>Readable files in Git. Review a change, revert it, rebuild the index any time.</p></article>", `<article class="tech-item"><code>${c.moat6Code}</code><h3>${c.moat6Title}</h3><p>${c.moat6Body}</p></article>`],
    ["<span class=\"eyebrow\">see the evidence</span>", `<span class="eyebrow">${c.releaseProofEyebrow}</span>`],
    ["<h2 id=\"release-proof-title\">Don’t trust the agent. Read the receipt.</h2>", `<h2 id="release-proof-title">${c.releaseProofTitle}</h2>`],
    ["<p class=\"release-copy\">Every task report keeps three things apart that most tools blur together.</p>", `<p class="release-copy">${c.releaseProofBody}</p>`],
    ["aria-label=\"What task reports distinguish\"", `aria-label="${escAttr(c.releaseMetricsAria)}"`],
    ["<strong>delivered</strong>", `<strong>${c.releaseRevision}</strong>`],
    ["<span>what Hunch handed the agent</span>", `<span>${c.releaseDeclaration}</span>`],
    ["<strong>reported</strong>", `<strong>${c.releaseConfidence}</strong>`],
    ["<span>what the agent says it used</span>", `<span>${c.releaseFile}</span>`],
    ["<strong>checked</strong>", `<strong>${c.releaseEvidence}</strong>`],
    ["<span>what rules and commands actually ran</span>", `<span>${c.releaseInspection}</span>`],
    ["<p class=\"release-caveat\">A green test alone doesn’t prove Hunch helped. No evidence, no claim — it stays unverified. <a href=\"/docs#task-reports\">Read a task report →</a></p>", `<p class="release-caveat">${c.releaseCaveat}</p>`],
    ['<span class="eyebrow">the missing context</span>', `<span class="eyebrow">${c.storyEyebrow}</span>`],
    ['<h2>AI reads your code. It wasn’t there when you decided.</h2>', `<h2>${c.storyTitle}</h2>`],
    ['<p>It sees what the code does — not why, what broke last time, or what a small change will break next.</p>', `<p>${c.storyIntro}</p>`],
    ['<span class="story-when">Monday</span>', `<span class="story-when">${c.monday}</span>`],
    ['<span class="story-when">Months later</span>', `<span class="story-when">${c.monthsLater}</span>`],
    ['<span class="story-when">Next session</span>', `<span class="story-when">${c.nextSession}</span>`],
    ['<span class="story-when">With Hunch</span>', `<span class="story-when">${c.withHunch}</span>`],
    ['<h3>Your team fixes a logout bug.</h3>', `<h3>${c.story1Title}</h3>`],
    ['<p>Sign-ins move to the server, so a stolen key dies the moment someone logs out.</p>', `<p>${c.story1Body}</p>`],
    ['<h3>The code stays. The reason doesn’t.</h3>', `<h3>${c.story2Title}</h3>`],
    ['<p>The discussion is buried. The safe code now just looks overcomplicated.</p>', `<p>${c.story2Body}</p>`],
    ['<h3>An AI “cleans it up.”</h3>', `<h3>${c.story3Title}</h3>`],
    ['<p>The diff looks great. The logout bug is back.</p>', `<p>${c.story3Body}</p>`],
    ["<h3>The reason shows up first.</h3>", `<h3>${c.story4Title}</h3>`],
    ["<p>Once the lesson is recorded, Hunch puts the decision — and the bug it prevents — in front of the agent before it edits the file.</p>", `<p>${c.story4Body}</p>`],
    ["aria-label=\"Example project memory\"", `aria-label="${escAttr(c.receiptAria)}"`],
    ["<div class=\"receipt-head\"><span>before editing · <bdi>src/auth/session.ts</bdi></span><b>memory found</b></div>", `<div class="receipt-head"><span>${c.beforeEditing} · <bdi>src/auth/session.ts</bdi></span><b>${c.memoryFound}</b></div>`],
    ['<span class="receipt-kicker">Why this code exists</span>', `<span class="receipt-kicker">${c.whyExists}</span>`],
    ['<h3>Logging out must end access right away.</h3>', `<h3>${c.logoutTitle}</h3>`],
    ['<div class="receipt-row"><span>chosen</span><p>Keep sign-ins on the server, where they can be ended at once.</p></div>', `<div class="receipt-row"><span>${c.chosen}</span><p>${c.chosenBody}</p></div>`],
    ['<div class="receipt-row"><span>rejected</span><p>Trust a login token until its timer runs out.</p></div>', `<div class="receipt-row"><span>${c.rejected}</span><p>${c.rejectedBody}</p></div>`],
    ['<div class="receipt-row"><span>protects</span><p>A stolen token being used after logout.</p></div>', `<div class="receipt-row"><span>${c.protects}</span><p>${c.protectsBody}</p></div>`],
    ["<p class=\"receipt-foot\">example memory · source attached · advice, not a block</p>", `<p class="receipt-foot">${c.receiptFoot}</p>`],
    ['<span class="eyebrow">how hunch works</span>', `<span class="eyebrow">${c.changesEyebrow}</span>`],
    ["<h2>Remember. Retrieve. Check.</h2>", `<h2>${c.changesTitle}</h2>`],
    ["<p>Hunch gives the agent a short brief and a way to check its work. The agent still does the work.</p>", `<p>${c.changesIntro}</p>`],
    ["<span class=\"step-n\">01 / remember</span>", `<span class="step-n">${c.rememberLabel}</span>`], ["<h3>Save what you learned.</h3>", `<h3>${c.rememberTitle}</h3>`],
    ["<p>Capture decisions, corrections and findings, linked to the code and the source they came from.</p>", `<p>${c.rememberBody}</p>`],
    ["<span class=\"step-n\">02 / retrieve</span>", `<span class="step-n">${c.recallLabel}</span>`], ["<h3>Bring it back at the right moment.</h3>", `<h3>${c.recallTitle}</h3>`],
    ["<p>When a task starts, Hunch picks the memory that matters and delivers it through MCP or your assistant’s hooks. What arrives depends on the assistant.</p>", `<p>${c.recallBody}</p>`],
    ["<span class=\"step-n\">03 / check</span>", `<span class="step-n">${c.protectLabel}</span>`], ["<h3>Check, then show the receipt.</h3>", `<h3>${c.protectTitle}</h3>`],
    ["<p>Hunch runs the rules you trust and writes a task report: what it delivered, what the agent used, what actually passed.</p>", `<p>${c.protectBody}</p>`],
    ["<span class=\"eyebrow\">inside the coding tools</span>", `<span class="eyebrow">${c.underEyebrow}</span>`], ["<h2>Know what a change breaks before you make it.</h2>", `<h2>${c.underTitle}</h2>`],
    ["<p>For code, Hunch connects the reasons to the dependencies and to the rules your team chose to protect.</p>", `<p>${c.underIntro}</p>`],
    ["<code class=\"literal\">why</code>", `<code class="literal">${c.savedWithGit}</code>`], ["<code>blast radius</code>", `<code>${c.codeGraph}</code>`], ["<code>project DNA</code>", `<code>${c.mcpRules}</code>`], ["<code>compare</code>", `<code>${c.conformance}</code>`], ["<code>conform</code>", `<code>${c.provenance}</code>`], ["<code>change gate</code>", `<code>${c.localFirst}</code>`],
    ["<h3>Find the reason</h3>", `<h3>${c.gitMemoryTitle}</h3>`], ["<p>Decisions, rejected ideas and past failures behind any file or function.</p>", `<p>${c.gitMemoryBody}</p>`],
    ["<h3>See what depends on it</h3>", `<h3>${c.blastTitle}</h3>`], ["<p>Follow the code’s real connections to see what a change can reach.</p>", `<p>${c.blastBody}</p>`],
    ["<h3>Learn the house style</h3>", `<h3>${c.assistantsTitle}</h3>`], ["<p>See the terms and habits Hunch observed in this repo. Advice only.</p>", `<p>${c.assistantsBody}</p>`],
    ["<h3>Compare options</h3>", `<h3>${c.checksTitle}</h3>`], ["<p>Line up candidate branches against what you already decided.</p>", `<p>${c.checksBody}</p>`],
    ["<h3>Check the code still keeps its promises</h3>", `<h3>${c.receiptsTitle}</h3>`], ["<p>For example: does the payment path still check authorization?</p>", `<p>${c.receiptsBody}</p>`],
    ["<h3>Guard the rules you trust</h3>", `<h3>${c.yoursTitle}</h3>`], ["<p>Flags changes that break a trusted rule. Strict mode blocks only where that rule and your assistant allow it.</p>", `<p>${c.yoursBody}</p>`],
    ['<p class="tech-link">Want the technical details? <a href="/docs">Read how Hunch works →</a></p>', `<p class="tech-link">${c.shortVersion} <a href="/docs">${c.explore}</a></p>`],
    ['<span class="eyebrow">get started</span>', `<span class="eyebrow">${c.startEyebrow}</span>`], ["<h2>Start in one repository.</h2>", `<h2>${c.startTitle}</h2>`],
    ['<h3>Install Hunch</h3>', `<h3>${c.installTitle}</h3>`], ["<p>Install the CLI, then run hunch init in the project you want it to remember.</p>", `<p>${c.installBody}</p>`],
    ["<h3>Teach it your history</h3>", `<h3>${c.historyTitle}</h3>`], ["<p>Optional: backfill the last few months of Git, then review what it captured.</p>", `<p>${c.historyBody}</p>`],
    ["<h3>Ask why</h3>", `<h3>${c.askTitle}</h3>`], ["<p>Reload your assistant and ask why a file is built this way. Using Codex? Trust the hooks in /hooks first.</p>", `<p>${c.askBody}</p>`],
    ['aria-label="Supported assistants"', `aria-label="${escAttr(c.supportedAria)}"`],
    ['<span class="c-key"># install from npm — Node 22.13+</span>', `<span class="c-key">${c.installComment}</span>`], ['<span class="c-key"># connect Hunch to this project</span>', `<span class="c-key">${c.initComment}</span>`],
    ['<span class="c-key"># learn from the last 90 days</span>', `<span class="c-key">${c.backfillComment}</span>`], ["<span class=\"c-key\"># see your project's DNA</span>", `<span class="c-key">${c.dnaComment}</span>`], ['<span class="c-key"># ask what a file is for</span>', `<span class="c-key">${c.whyComment}</span>`],
    ['<button class="copybtn" data-copy="#install-cmd">copy</button>', `<button class="copybtn" data-copy="#install-cmd">${c.copy}</button>`],
    ["Hunch advises by default — nothing blocks until you say so. To update, run <code>hunch update</code>, reconnect your assistant, and in Codex review changed commands in <code>/hooks</code>.<br /><br />", `${c.advisoryNote}<br /><br />`],
    ['Claude Code? Install as a plugin instead:<br />', `${c.pluginPrompt}<br />`],
    ["<h2>One record, from customer issue to verified fix.</h2>", `<h2>${c.ctaTitle}</h2>`], ["<p>That’s the goal: a customer reports a problem, an agent fixes the code, another confirms it’s done. Shared state ships today; the Sofia pilot is testing the full handoff.</p>", `<p>${c.ctaBody}</p>`],
    ["<p class=\"about\">Hunch keeps the decisions, finished work and commitments your agents need to share.</p>", `<p class="about">${c.about}</p>`],
    [">product<", `>${c.product}<`], [">develop<", `>${c.develop}<`], [">connect<", `>${c.connect}<`], [">MCP tools<", `>${c.mcpTools}<`], [">VS Code extension<", `>${c.vscodeExtension}<`],
    ['{ label: "decision", angle: -2.55 }', `{ label: ${JSON.stringify(c.canvasDecision)}, angle: -2.55 }`], ['{ label: "bug", angle: -0.18 }', `{ label: ${JSON.stringify(c.canvasBug)}, angle: -0.18 }`], ['{ label: "rule", angle: 1.72 }', `{ label: ${JSON.stringify(c.canvasRule)}, angle: 1.72 }`],
    ['ctx.fillText("why", x, y + 0.5);', `ctx.fillText(${JSON.stringify(c.canvasWhy)}, x, y + 0.5);`], ['ctx.fillText("reason recalled before edit", x, y + r + 34);', `ctx.fillText(${JSON.stringify(c.canvasReason)}, x, y + r + 34);`],
    ['const RECEIPTS = ["dec_8b2e · held", "dec_a466 · held", "dec_e0a3 · held", "dec_fd36 · held"];', `const RECEIPTS = ["dec_8b2e · ${c.held}", "dec_a466 · ${c.held}", "dec_e0a3 · ${c.held}", "dec_fd36 · ${c.held}"];`],
    ['const BLOCKS = ["con_9027 · blocked", "con_2ce3 · blocked"];', `const BLOCKS = ["con_9027 · ${c.blocked}", "con_2ce3 · ${c.blocked}"];`],
    ["try { await navigator.clipboard.writeText(code.textContent); btn.textContent = 'copied'; setTimeout(() => btn.textContent = 'copy', 1600); } catch {}", `try { await navigator.clipboard.writeText(code.textContent); btn.textContent = ${JSON.stringify(c.copied)}; setTimeout(() => btn.textContent = ${JSON.stringify(c.copy)}, 1600); } catch {}`],
  ];
}

function replaceRequired(html, from, to, locale) {
  if (!html.includes(from)) throw new Error(`[${locale}] source fragment not found: ${from.slice(0, 100)}`);
  return html.replaceAll(from, to);
}

const source = normalizeLf(await readFile(sourcePath, "utf8"));
for (const [locale, copy] of Object.entries(locales)) {
  let html = source;
  html = replaceRequired(html, '<html lang="en">', `<html lang="${locale}"${copy.dir === "rtl" ? ' dir="rtl"' : ""}>`, locale);
  html = replaceRequired(html, '<meta property="og:url" content="https://www.hunchmemory.com/" />', `<meta property="og:url" content="${siteOrigin}/${locale}" />`, locale);
  html = replaceRequired(html, '<meta property="og:locale" content="en_US" />', `<meta property="og:locale" content="${copy.ogLocale}" />`, locale);
  html = replaceRequired(html, '<link rel="canonical" href="https://www.hunchmemory.com/" />', `<link rel="canonical" href="${siteOrigin}/${locale}" />`, locale);
  html = replaceRequired(html, '<a class="brand" href="/">', `<a class="brand" href="/${locale}">`, locale);
  html = replaceRequired(html, '<option value="/" selected>EN</option>', '<option value="/">EN</option>', locale);
  html = replaceRequired(html, `<option value="/${locale}">${locale.toUpperCase()}</option>`, `<option value="/${locale}" selected>${locale.toUpperCase()}</option>`, locale);
  for (const [from, to] of fragments(copy)) html = replaceRequired(html, from, to, locale);
  html = html.replaceAll('href="/blog/post?slug=the-state-layer"', `href="/${locale}/blog/post?slug=the-state-layer"`);
  html = html.replaceAll('href="/blog/"', `href="/${locale}/blog"`);
  html = html.replaceAll('href="/changelog"', `href="/${locale}/changelog"`);
  html = html.replace("<!DOCTYPE html>", `<!DOCTYPE html>\n<!-- Generated by tooling/generate-site-locales.mjs. Edit site/index.html or the locale dictionary, then regenerate. -->`);

  const banned = ["7-episode series", "Then go deeper", "Read the thesis", "Agents are probabilistic. Organizations need deterministic state.", "Help AI understand your code", "Your code has DNA", "Hunch learns how your project works", "the missing context", "AI reads your code", "Your team fixes a logout bug", "An AI “cleans it up", "The right DNA Strand activates first", "how hunch works", "Every task activates the right DNA Strand", "lean by design", "Less context. Better understanding", "right task", "more than context", "A set of tools guides the agent", "Understands why", "Install Hunch", "Install once. Work normally", "Learn the Project DNA", "Hunch advises by default", "One project. One DNA", "Your agents forget", "Read the receipt", "Teach it your history"];
  const visibleHtml = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const phrase of banned) if (visibleHtml.includes(phrase)) throw new Error(`[${locale}] untranslated visible phrase: ${phrase}`);

  const targetDir = path.join(repoRoot, "site", locale);
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, "index.html"), html, "utf8");
  console.log(`generated site/${locale}/index.html (${copy.dir})`);
}

if (process.argv.includes("--homepage-only")) process.exit(0);

const blogDir = path.join(repoRoot, "site", "blog");
const [blogIndexSource, blogPostSource, postsSource] = (await Promise.all([
  readFile(path.join(blogDir, "index.html"), "utf8"),
  readFile(path.join(blogDir, "post.html"), "utf8"),
  readFile(path.join(blogDir, "posts.js"), "utf8"),
])).map(normalizeLf);

const sourceSlugs = [...postsSource.matchAll(/\bslug:\s*"([^"]+)"/g)].map((match) => match[1]);
if (!sourceSlugs.length) throw new Error("No blog posts found in site/blog/posts.js");
for (const [locale, copy] of Object.entries(blogLocales)) {
  const translatedSlugs = copy.posts.map((entry) => entry.slug);
  if (new Set(translatedSlugs).size !== sourceSlugs.length || translatedSlugs.some((slug, index) => slug !== sourceSlugs[index])) {
    throw new Error(`[${locale}] blog translations must cover all ${sourceSlugs.length} posts in source order`);
  }
}

const browserLocaleData = Object.fromEntries(Object.entries(blogLocales).map(([locale, copy]) => [locale, {
  dateLocale: copy.dateLocale,
  ui: copy.ui,
  posts: copy.posts,
}]));
const blogI18nScript = `/* Generated by tooling/generate-site-locales.mjs from tooling/blog-locales.mjs. */
window.BLOG_I18N = ${JSON.stringify(browserLocaleData)};
(function () {
  const escapeHtml = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  window.localizeBlogPosts = function (sourcePosts, locale) {
    const localeData = window.BLOG_I18N?.[locale];
    if (!localeData) return Array.from(sourcePosts);
    const translations = new Map(localeData.posts.map((entry) => [entry.slug, entry]));
    return Array.from(sourcePosts, (source) => {
      const translated = translations.get(source.slug);
      if (!translated) return source;
      const body = '<p class="lead">' + escapeHtml(translated.dek) + '</p>'
        + '<h2>' + escapeHtml(localeData.ui.keyIdeas) + '</h2><ul>'
        + translated.points.map((point) => '<li>' + escapeHtml(point) + '</li>').join("")
        + '</ul><h2>' + escapeHtml(localeData.ui.takeawayHeading) + '</h2><p>'
        + escapeHtml(translated.takeaway) + '</p>';
      return {
        ...source,
        title: translated.title,
        dek: translated.dek,
        tag: translated.tag,
        read: translated.read,
        body,
        download: translated.download || source.download,
        cover: source.cover ? { ...source.cover, alt: translated.title } : source.cover,
      };
    });
  };
})();
`;
await writeFile(path.join(blogDir, "i18n.js"), blogI18nScript, "utf8");
console.log("generated site/blog/i18n.js");

// A physical directory index keeps /blog/post reliable on Windows-built Vercel
// outputs, where cleanUrls override entries may otherwise contain backslashes.
const englishPostDir = path.join(blogDir, "post");
await mkdir(englishPostDir, { recursive: true });
await writeFile(path.join(englishPostDir, "index.html"), blogPostSource, "utf8");
console.log("generated site/blog/post/index.html");

function localizeBlogTemplate(source, locale, copy, page) {
  const ui = copy.ui;
  const isPost = page === "post";
  const blogBase = `/${locale}/blog`;
  const canonical = `${siteOrigin}${blogBase}${isPost ? "/post" : ""}`;
  let html = source;
  html = replaceRequired(html, '<html lang="en">', `<html lang="${locale}"${copy.dir === "rtl" ? ' dir="rtl"' : ""}>`, `${locale}/${page}`);
  html = replaceRequired(html, isPost ? "<title>The Hunch Blog</title>" : "<title>The Hunch Blog — shared records for AI agents</title>", `<title>${ui.pageTitle}</title>`, `${locale}/${page}`);
  html = replaceRequired(html,
    isPost ? '<meta name="description" content="Notes, benchmarks and field reports on engineering memory, deterministic state, and shared records for AI agents." />' : '<meta name="description" content="Notes, benchmarks and field reports on engineering memory, deterministic state, and keeping AI-assisted work grounded in sources." />',
    `<meta name="description" content="${escAttr(ui.pageDescription)}" />`, `${locale}/${page}`);
  html = replaceRequired(html,
    isPost ? '<link rel="canonical" id="canonical-url" href="https://www.hunchmemory.com/blog/post" />' : '<link rel="canonical" href="https://www.hunchmemory.com/blog" />',
    isPost ? `<link rel="canonical" id="canonical-url" href="${canonical}" />` : `<link rel="canonical" href="${canonical}" />`, `${locale}/${page}`);
  html = replaceRequired(html, '<nav class="nav" aria-label="Main">', `<nav class="nav" aria-label="${escAttr(ui.mainNav)}">`, `${locale}/${page}`);
  html = replaceRequired(html, '<a class="brand" href="/">', `<a class="brand" href="/${locale}">`, `${locale}/${page}`);
  html = replaceRequired(html, '<a href="/#how" class="hide-s">How it works</a>', `<a href="/${locale}/#how" class="hide-s">${ui.navHow}</a>`, `${locale}/${page}`);
  html = replaceRequired(html, '<a href="/#inside" class="hide-s">Under the hood</a>', `<a href="/${locale}/#inside" class="hide-s">${ui.navInside}</a>`, `${locale}/${page}`);
  html = replaceRequired(html, '<a href="/docs" class="hide-xs">Docs</a>', `<a href="/docs" class="hide-xs">${ui.docs}</a>`, `${locale}/${page}`);
  html = replaceRequired(html, '<a href="/blog" class="hide-xs" aria-current="page">Blog</a>', `<a href="${blogBase}" class="hide-xs" aria-current="page">${ui.blog}</a>`, `${locale}/${page}`);
  html = replaceRequired(html, '<a href="/changelog" class="hide-s">Changelog</a>', `<a href="/${locale}/changelog" class="hide-s">${ui.changelog}</a>`, `${locale}/${page}`);
  html = replaceRequired(html, '<span class="sr-only">Language</span>', `<span class="sr-only">${ui.language}</span>`, `${locale}/${page}`);
  html = replaceRequired(html, 'aria-label="Language"', `aria-label="${escAttr(ui.language)}"`, `${locale}/${page}`);
  html = replaceRequired(html, `<option value="/${isPost ? "blog/post" : "blog"}" selected>EN</option>`, `<option value="/${isPost ? "blog/post" : "blog"}">EN</option>`, `${locale}/${page}`);
  html = replaceRequired(html, `<option value="/${locale}/blog${isPost ? "/post" : ""}">${locale.toUpperCase()}</option>`, `<option value="/${locale}/blog${isPost ? "/post" : ""}" selected>${locale.toUpperCase()}</option>`, `${locale}/${page}`);
  html = replaceRequired(html, '<a class="btn" href="/#start">Get started</a>', `<a class="btn" href="/${locale}/#start">${ui.getStarted}</a>`, `${locale}/${page}`);

  if (isPost) {
    html = replaceRequired(html, '<span>© Hunch — shared records for AI agents.</span>', `<span>${ui.footerTag}</span>`, `${locale}/${page}`);
    html = replaceRequired(html, '<span><a href="/blog">← All posts</a>', `<span><a href="${blogBase}">${ui.allPostsFooter}</a>`, `${locale}/${page}`);
  } else {
    html = replaceRequired(html, '<span class="eyebrow"><span>●</span> The Hunch Blog</span>', `<span class="eyebrow"><span>●</span> ${ui.eyebrow}</span>`, `${locale}/${page}`);
    html = replaceRequired(html, '<h1>Keeping work continuous across agents.</h1>', `<h1>${ui.mastheadTitle}</h1>`, `${locale}/${page}`);
    html = replaceRequired(html, '<p>Benchmarks, arguments and field notes on engineering memory, deterministic state, and the checks that keep decisions, completed work and commitments tied to sources.</p>', `<p>${ui.mastheadIntro}</p>`, `${locale}/${page}`);
    html = replaceRequired(html, '<div class="kicker">Pinned</div>', `<div class="kicker">${ui.pinned}</div>`, `${locale}/${page}`);
    html = replaceRequired(html, '<div class="kicker">All posts</div>', `<div class="kicker">${ui.allPosts}</div>`, `${locale}/${page}`);
    html = replaceRequired(html, '<span>© Hunch — shared records for AI agents · git-native, MCP-native.</span>', `<span>${ui.footerTag} · git-native, MCP-native.</span>`, `${locale}/${page}`);
  }

  return html.replace("<!doctype html>", `<!doctype html>\n<!-- Generated by tooling/generate-site-locales.mjs. Edit site/blog templates or tooling/blog-locales.mjs, then regenerate. -->`);
}

for (const [locale, copy] of Object.entries(blogLocales)) {
  const targetDir = path.join(repoRoot, "site", locale, "blog");
  const postTargetDir = path.join(targetDir, "post");
  await Promise.all([mkdir(targetDir, { recursive: true }), mkdir(postTargetDir, { recursive: true })]);
  const indexHtml = localizeBlogTemplate(blogIndexSource, locale, copy, "index");
  const postHtml = localizeBlogTemplate(blogPostSource, locale, copy, "post");
  const visibleIndex = indexHtml.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const phrase of ["Keeping work continuous", "All posts", "Get started", "How it works"]) {
    if (visibleIndex.includes(phrase)) throw new Error(`[${locale}/blog] untranslated visible phrase: ${phrase}`);
  }
  await Promise.all([
    writeFile(path.join(targetDir, "index.html"), indexHtml, "utf8"),
    writeFile(path.join(targetDir, "post.html"), postHtml, "utf8"),
    writeFile(path.join(postTargetDir, "index.html"), postHtml, "utf8"),
  ]);
  console.log(`generated site/${locale}/blog/index.html and post/index.html (${copy.dir})`);
}

const changelogSourcePath = path.join(repoRoot, "site", "changelog.html");
const changelogSource = normalizeLf(await readFile(changelogSourcePath, "utf8"));
const changelogRowPattern = /<div class="clog-row"><span class="rel-tag">([^<]+)<\/span><span class="clog-t">([\s\S]*?)<\/span><\/div>/g;
// Shared with test/changelog-locales.test.ts so the guard below is enforced on every
// `npm test`, not only when someone happens to run this script by hand.
const changelogRowCount = countChangelogRows(changelogSource);
for (const [locale, copy] of Object.entries(changelogLocales)) {
  if (copy.titles.length !== changelogRowCount) throw new Error(`[${locale}/changelog] expected ${changelogRowCount} translated release titles, received ${copy.titles.length}`);
}

function escapeVisible(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const monthIndex = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function localizeChangelogDate(value, locale) {
  const [month, dayText, yearText] = value.replace(",", "").split(/\s+/);
  const date = new Date(Date.UTC(Number(yearText), monthIndex[month], Number(dayText)));
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(date);
}

function localizeChangelogTemplate(source, locale, copy) {
  const ui = copy.ui;
  const route = `/${locale}/changelog`;
  let html = source;
  html = replaceRequired(html, '<html lang="en">', `<html lang="${locale}"${copy.dir === "rtl" ? ' dir="rtl"' : ""}>`, `${locale}/changelog`);
  html = replaceRequired(html, "<title>Hunch changelog — releases and current capabilities</title>", `<title>${ui.pageTitle}</title>`, `${locale}/changelog`);
  html = replaceRequired(html, '<meta name="description" content="Every Hunch release — engineering memory, shared deterministic state, integrations, and production qualifications." />', `<meta name="description" content="${escAttr(ui.pageDescription)}" />`, `${locale}/changelog`);
  html = replaceRequired(html, '<link rel="canonical" href="https://www.hunchmemory.com/changelog" />', `<link rel="canonical" href="${siteOrigin}${route}" />`, `${locale}/changelog`);
  html = replaceRequired(html, '<nav class="nav" aria-label="Main">', `<nav class="nav" aria-label="${escAttr(ui.mainNav)}">`, `${locale}/changelog`);
  html = replaceRequired(html, '<a class="brand" href="/">', `<a class="brand" href="/${locale}">`, `${locale}/changelog`);
  html = replaceRequired(html, '<a href="/#how" class="hide-s">How it works</a>', `<a href="/${locale}/#how" class="hide-s">${ui.navHow}</a>`, `${locale}/changelog`);
  html = replaceRequired(html, '<a href="/#inside" class="hide-s">Under the hood</a>', `<a href="/${locale}/#inside" class="hide-s">${ui.navInside}</a>`, `${locale}/changelog`);
  html = replaceRequired(html, '<a href="/docs" class="hide-xs">Docs</a>', `<a href="/docs" class="hide-xs">${ui.docs}</a>`, `${locale}/changelog`);
  html = replaceRequired(html, '<a href="/blog" class="hide-xs">Blog</a>', `<a href="/${locale}/blog" class="hide-xs">${ui.blog}</a>`, `${locale}/changelog`);
  html = replaceRequired(html, '<a href="/changelog" class="hide-s" aria-current="page">Changelog</a>', `<a href="${route}" class="hide-s" aria-current="page">${ui.changelog}</a>`, `${locale}/changelog`);
  html = replaceRequired(html, '<span class="sr-only">Language</span>', `<span class="sr-only">${ui.language}</span>`, `${locale}/changelog`);
  html = replaceRequired(html, 'aria-label="Language"', `aria-label="${escAttr(ui.language)}"`, `${locale}/changelog`);
  html = replaceRequired(html, '<option value="/changelog" selected>EN</option>', '<option value="/changelog">EN</option>', `${locale}/changelog`);
  html = replaceRequired(html, `<option value="/${locale}/changelog">${locale.toUpperCase()}</option>`, `<option value="/${locale}/changelog" selected>${locale.toUpperCase()}</option>`, `${locale}/changelog`);
  html = replaceRequired(html, '<a class="btn" href="/#start">Get started</a>', `<a class="btn" href="/${locale}/#start">${ui.getStarted}</a>`, `${locale}/changelog`);
  html = replaceRequired(html, '<span class="eyebrow">changelog · newest first</span>', `<span class="eyebrow">${ui.eyebrow}</span>`, `${locale}/changelog`);
  html = replaceRequired(html, '<h1>Every release, since <em>v0.1</em>.</h1>', `<h1>${ui.heading}</h1>`, `${locale}/changelog`);
  html = replaceRequired(html, '<p>From Git-native engineering memory to shared deterministic state — the whole arc, newest first.</p>', `<p>${ui.intro}</p>`, `${locale}/changelog`);
  html = replaceRequired(html, '<span>© Hunch — shared records for AI agents.</span>', `<span>${ui.footer}</span>`, `${locale}/changelog`);
  html = replaceRequired(html, '<span><a href="/">Home</a> · <a href="/docs">Docs</a> · <a href="/blog">Blog</a> · <a href="https://github.com/davesheffer/hunch/releases" target="_blank" rel="noopener">GitHub releases</a></span>', `<span><a href="/${locale}">${ui.home}</a> · <a href="/docs">${ui.docs}</a> · <a href="/${locale}/blog">${ui.blog}</a> · <a href="https://github.com/davesheffer/hunch/releases" target="_blank" rel="noopener">${ui.githubReleases}</a></span>`, `${locale}/changelog`);

  let titleIndex = 0;
  html = html.replace(changelogRowPattern, (_row, version) => `<div class="clog-row"><span class="rel-tag">${version}</span><span class="clog-t"><b>${escapeVisible(copy.titles[titleIndex++])}</b></span></div>`);
  if (titleIndex !== changelogRowCount) throw new Error(`[${locale}/changelog] replaced ${titleIndex}/${changelogRowCount} release rows`);
  html = html.replace(/<div class="clog-date">([^<]+)<\/div>/g, (_match, date) => `<div class="clog-date">${localizeChangelogDate(date, copy.dateLocale)}</div>`);
  html = html.replace("<!doctype html>", `<!doctype html>\n<!-- Generated by tooling/generate-site-locales.mjs. Edit site/changelog.html or tooling/changelog-locales.mjs, then regenerate. -->`);
  const visibleHtml = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const phrase of ["Every release", "From Git-native", "How it works", "Get started", "Initial release"]) {
    if (visibleHtml.includes(phrase)) throw new Error(`[${locale}/changelog] untranslated visible phrase: ${phrase}`);
  }
  return html;
}

const englishChangelogDir = path.join(repoRoot, "site", "changelog");
await mkdir(englishChangelogDir, { recursive: true });
await writeFile(path.join(englishChangelogDir, "index.html"), changelogSource, "utf8");
console.log("generated site/changelog/index.html");

for (const [locale, copy] of Object.entries(changelogLocales)) {
  const targetDir = path.join(repoRoot, "site", locale, "changelog");
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, "index.html"), localizeChangelogTemplate(changelogSource, locale, copy), "utf8");
  console.log(`generated site/${locale}/changelog/index.html (${copy.dir})`);
}
