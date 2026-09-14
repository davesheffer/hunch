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
    title: "Hunch — תיעוד משותף לסוכני AI",
    description: "החלטות, עבודה שהושלמה והתחייבויות נשארות זמינות לסוכני AI, יחד עם המקורות שלהן. זיכרון הנדסי מבוסס Git ושרת מצב לאירוח עצמי.",
    ogDescription: "בסיס משותף לעבודה של סוכנים: החלטות בפרויקט, תיעוד פעולות והתחייבויות, עם מקורות וכללים ברורים לעדכון.",
    mainNav: "ניווט ראשי", language: "שפה",
    thesisTag: "מצב דטרמיניסטי", thesisText: "מה זה מצב דטרמיניסטי, במילים פשוטות.", thesisCta: "לקריאת התזה ←",
    navHow: "כך זה עובד", navInside: "מאחורי הקלעים", docs: "תיעוד", blog: "בלוג", changelog: "יומן שינויים",
    getStarted: "מתחילים", seeHow: "כך זה עובד", readDocs: "קריאת התיעוד", benchmark: "מדד ביצועים",
    releaseEyebrow: "Project DNA לעוזרי קוד מבוססי AI", moatEyebrow: "זמין היום", moatTitle: "העבודה ממשיכה מסשן לסשן.", moatIntro: "Hunch שומר רשומות מובנות ב-Git. אפשר לעיין בהן בדפדפן או לחבר סוכנים דרך MCP, HTTP, שורת הפקודה, TypeScript או Python.", moat1Code: "זיכרון", moat1Title: "לשמור את הסיבות", moat1Body: "החלטות, גישות שנדחו, באגים ושאלות פתוחות נשמרים לצד הקוד שהם מסבירים.", moat2Code: "החלטות", moat2Title: "להבהיר מה משתנה", moat2Body: "החלטות נוכחיות שסותרות זו את זו נדחות. החלפת החלטה משאירה היסטוריה של השינוי.", moat3Code: "גישה", moat3Title: "לשתף עם הסוכנים המתאימים", moat3Body: "בוחרים אילו סוכנים יכולים לגשת למחיצה, ומגבילים גישה לרשומות מסוימות לפי הצורך. אפשר להוסיף חתימה על בקשות באמצעות מפתח פרטי.", moat4Code: "פעולות", moat4Title: "לעקוב אחרי מה שנעשה ומה שנותר", moat4Body: "רואים בדפדפן עבודה שהושלמה, התחייבויות פתוחות ומקורות מצוטטים. עבודה שמצבה לא ידוע או לא אומת נשארת מסומנת כך.", moat5Code: "שליטה", moat5Title: "לבחור מה הופך לכלל", moat5Body: "מתעדים מוסכמות של משתמש, צוות וארגון עם המקורות שלהן. הן נשארות בגדר המלצה; חסימה מחייבת כלל שניתן בו אמון מפורש ומצב strict.", moat6Code: "git", moat6Title: "התיעוד נשאר בשליטה מקומית", moat6Body: "הרשומות הן קבצים קריאים. Git מאפשר לסקור ולבטל שינויים שנשמרו בקומיט; אפשר לבנות מחדש את האינדקסים.", heroTitle: "לכל סוכן<br /><b>בסיס משותף לעבודה.</b>",
    heroLede: "Hunch שומר החלטות, עבודה שהושלמה והתחייבויות יחד עם המקורות שלהן. אפשר להתחיל בזיכרון הנדסי לסוכני קוד, או לחבר סוכנים לשרת מצב באירוח עצמי.",
    heroNote: "לא פרסונה. לא עוד פרומפט. הבנה ניתנת למעקב של הדרך שבה המאגר באמת עובד — עם רמת ביטחון, עדכניות וראיות מצורפות.",
    releaseProofEyebrow: "לראות את הראיות", releaseProofTitle: "לראות מה הגיע לסוכן — ומה נבדק.",
    releaseProofBody: "דוחות משימה מציגים את הזיכרון שנמסר, את מה שהסוכן אומר שהשתמש בו, ואת תוצאות הכללים והפקודות שהורצו בפועל.",
    releaseMetricsAria: "ההבחנות בדוחות משימה", releaseRevision: "נמסר", releaseDeclaration: "הזיכרון ש-Hunch סיפק למשימה הזאת", releaseConfidence: "דווח", releaseFile: "מה שהסוכן אומר שיישם", releaseEvidence: "נבדק", releaseInspection: "תוצאות של כללים ופקודות נשמרות כראיות נפרדות",
    releaseCaveat: "בדיקה שעברה אינה מוכיחה לבדה ש-Hunch גרם לתוצאה. כשחסרות ראיות, התוצאה נשארת לא מאומתת. <a href=\"/docs#task-reports\">לקריאת דוח משימה →</a>",
    storyEyebrow: "ההקשר החסר", storyTitle: "AI יכול לקרוא את הקוד. הוא לא רואה את הסיפור המלא.", storyIntro: "הוא רואה קבצים, אבל לא למה התקבלו החלטות, מה נכשל בעבר או מה שינוי קטן עלול לשבור.",
    monday: "יום שני", monthsLater: "כעבור חודשים", nextSession: "בסשן הבא", withHunch: "עם Hunch",
    story1Title: "הצוות מתקן באג בהתנתקות.", story1Body: "מצב ההתחברות נשמר בשרת, כך שמפתח גנוב מפסיק לעבוד ברגע שמתנתקים.",
    story2Title: "הקוד נשאר. הסיבה הולכת לאיבוד.", story2Body: "קשה למצוא את הדיון הישן. הקוד הבטוח יותר נראה עכשיו מסובך מהנדרש.",
    story3Title: "AI רואה קוד מורכב ו״מפשט״ אותו.", story3Body: "השינוי נראה נקי, אבל מחזיר את אותו באג בהתנתקות.",
    story4Title: "הסיבה המקורית מגיעה לסוכן הבא.", story4Body: "כשהלקח מתועד והחיבור פעיל, Hunch יכול להציג את ההחלטה ואת הבאג שהיא מונעת לפני העריכה.",
    receiptAria: "דוגמה לזיכרון פרויקט", beforeEditing: "לפני עריכת", memoryFound: "נמצא זיכרון", whyExists: "למה הקוד הזה קיים",
    logoutTitle: "התנתקות חייבת להפסיק את הגישה מיד.", chosen: "נבחר", chosenBody: "לשמור את מצב ההתחברות בשרת, שם אפשר לסיים אותה מיד.",
    rejected: "נדחה", rejectedBody: "לסמוך על אסימון התחברות עד שתוקפו יפוג.",
    protects: "מגן מפני", protectsBody: "שימוש באסימון גנוב אחרי ההתנתקות.", receiptFoot: "זיכרון לדוגמה · המקור מצורף · בגדר עצה כברירת מחדל",
    changesEyebrow: "כך Hunch עובד", changesTitle: "לזכור. לשלוף. לבדוק.", changesIntro: "Hunch נותן לעוזר תדריך ממוקד וכלים לבדיקת העבודה. העוזר עדיין מתכנן ומבצע את המשימה.",
    rememberLabel: "01 / לזכור", rememberTitle: "לשמור את ההיסטוריה השימושית.", rememberBody: "מתעדים החלטות, תיקונים וממצאים ומקשרים אותם לקוד ולמקורות, כדי שיהיה אפשר למצוא את הסיבה גם בהמשך.",
    recallLabel: "02 / לשלוף", recallTitle: "להחזיר את מה שחשוב.", recallBody: "בוחרים זיכרון רלוונטי למשימה דרך MCP והוקים נתמכים של העוזר. היקף הכיסוי תלוי בחיבור.",
    protectLabel: "03 / לבדוק", protectTitle: "לבדוק ולהציג את התוצאה.", protectBody: "בודקים כללים נתמכים ושומרים דוח משימה שמפריד בין זיכרון שנמסר, שימוש שדווח ובדיקות שנצפו.",
    underEyebrow: "בתוך כלי הקוד", underTitle: "להבין שינוי לפני שמבצעים אותו.", underIntro: "הזיכרון ההנדסי מחבר בין הסיבות שמאחורי הקוד, התלויות שלו והכללים שהצוות בחר להגן עליהם.",
    savedWithGit: "why", codeGraph: "טווח השפעה", mcpRules: "Project DNA", conformance: "compare", provenance: "conform", localFirst: "בדיקת שינויים",
    gitMemoryTitle: "למצוא את הסיבה", gitMemoryBody: "קוראים את ההחלטות, הרעיונות שנדחו והכשלים מהעבר שמאחורי קובץ או סמל בקוד.",
    blastTitle: "לראות מה תלוי בו", blastBody: "עוקבים אחרי קשרים שמופו בקוד כדי להבין על מה שינוי עשוי להשפיע.",
    assistantsTitle: "להכיר את המוסכמות", assistantsBody: "בוחנים מינוח והרגלי עבודה שנצפו. התצפיות האלה נשארות בגדר עצה.",
    checksTitle: "להשוות שינויים", checksBody: "משווים ענפים מועמדים מול החלטות ואילוצים מתועדים.",
    receiptsTitle: "לבדוק את הכוונה המתועדת", receiptsBody: "בודקים קשרי קוד נתמכים, למשל אם מסלול תשלום עדיין קורא לבדיקת הרשאה.",
    yoursTitle: "להגן על כללים שניתנה להם סמכות", yoursBody: "מסמנים התנגשויות עם כללים נתמכים. מצב strict חוסם רק כשהכלל והחיבור מאפשרים זאת.",
    shortVersion: "רוצים את הפרטים הטכניים?", explore: "כך Hunch עובד ←",
    startEyebrow: "מתחילים", startTitle: "מתחילים במאגר.",
    installTitle: "התקינו את Hunch", installBody: "מתקינים את כלי ה-CLI ומריצים hunch init בתוך הפרויקט שהזיכרון מיועד לו.",
    historyTitle: "להוסיף את הסיבות שמאחורי הקוד", historyBody: "אפשר להשלים זיכרון מהיסטוריית Git האחרונה, ואז לסקור את ההחלטות והמקורות שנלכדו.",
    askTitle: "להתחבר ולשאול", askBody: "טוענים מחדש את העוזר ושואלים למה קובץ בנוי כך. ב-Codex יש לאשר תחילה את ההוקים דרך /hooks.",
    supportedAria: "עוזרים נתמכים", installComment: "# התקנה מ-npm — נדרש Node 22.13+", initComment: "# חיבור Hunch לפרויקט ולעוזרים", backfillComment: "# אפשר ללמוד מ-90 הימים האחרונים", dnaComment: "# בדיקת ה-DNA מבוסס הראיות של המאגר", whyComment: "# לשאול למה קובץ קיים",
    copy: "העתקה", copied: "הועתק", advisoryNote: "Hunch נותן עצה כברירת מחדל. חסימה מחייבת בחירה מפורשת. לעדכון, מריצים <code>hunch update</code>, מחברים מחדש את העוזר וסוקרים פקודות Codex שהשתנו ב-<code>/hooks</code>.", pluginPrompt: "משתמשים ב-Claude Code? התקינו במקום זאת כתוסף:",
    ctaTitle: "נבנה להמשכיות בין סוכנים.", ctaBody: "המטרה: פנייה של לקוח הופכת לתיקון בקוד ולהמשך טיפול מאומת. המצב המשותף זמין היום; הפיילוט של Sofia בודק את העברת הטיפול מקצה לקצה.",
    about: "Hunch שומר את ההחלטות, תיעוד העבודה וההתחייבויות שסוכנים צריכים לשתף.",
    product: "מוצר", develop: "פיתוח", connect: "קישורים", mcpTools: "כלי MCP", vscodeExtension: "תוסף ל-VS Code",
    canvasDecision: "החלטה", canvasBug: "באג", canvasRule: "כלל", canvasWhy: "למה", canvasReason: "הסיבה נשלפה לפני העריכה", held: "נשמר", blocked: "נחסם",
  },
  ru: {
    dir: "ltr", ogLocale: "ru_RU",
    title: "Hunch — общие записи для ИИ-агентов",
    description: "Решения, выполненная работа и обязательства доступны ИИ-агентам вместе с источниками. Инженерная память на основе Git и сервер состояния для самостоятельного размещения.",
    ogDescription: "Общая основа для работы агентов: решения по проекту, записи о действиях и обязательства, с источниками и понятными правилами обновления.",
    mainNav: "Основная навигация", language: "Язык",
    thesisTag: "Детерминированное состояние", thesisText: "Что такое детерминированное состояние, простыми словами.", thesisCta: "Читать тезис →",
    navHow: "Как это работает", navInside: "Что внутри", docs: "Документация", blog: "Блог", changelog: "История изменений",
    getStarted: "Начать", seeHow: "Посмотреть, как это работает", readDocs: "Читать документацию", benchmark: "Бенчмарк",
    releaseEyebrow: "ДНК проекта для ИИ-агентов по коду", moatEyebrow: "доступно сегодня", moatTitle: "Сохраняйте связь между рабочими сессиями.", moatIntro: "Hunch хранит структурированные записи в Git. Просматривайте их в браузере или подключайте агентов через MCP, HTTP, CLI, TypeScript или Python.", moat1Code: "память", moat1Title: "Сохраняйте причины", moat1Body: "Храните решения, отвергнутые подходы, ошибки и открытые вопросы рядом с кодом, который они объясняют.", moat2Code: "решения", moat2Title: "Делайте изменения явными", moat2Body: "Противоречащие друг другу действующие решения отклоняются. При замене решения сохраняется история изменений.", moat3Code: "доступ", moat3Title: "Делитесь с нужными агентами", moat3Body: "Выбирайте агентов с доступом к разделу и при необходимости ограничивайте доступ к отдельным записям. Привязка к ключу позволяет требовать подпись каждого запроса.", moat4Code: "действия", moat4Title: "Следите за сделанным и предстоящим", moat4Body: "Просматривайте выполненную работу, открытые обязательства и указанные источники в браузере. Неизвестный или непроверенный результат сохраняет этот статус.", moat5Code: "контроль", moat5Title: "Выбирайте, что станет правилом", moat5Body: "Записывайте соглашения пользователя, команды и организации с источниками. Они остаются рекомендациями; для блокировки нужны явно доверенное правило и строгий режим.", moat6Code: "git", moat6Title: "Записи остаются вашими", moat6Body: "Записи — это читаемые файлы. Git позволяет просматривать и отменять закоммиченные изменения; индексы можно построить заново.", heroTitle: "Дайте каждому агенту<br /><b>общую основу для работы.</b>",
    heroLede: "Hunch хранит решения, выполненную работу и обязательства вместе с их источниками. Начните с инженерной памяти для агентов по коду или подключите агентов к собственному серверу состояния.",
    heroNote: "Не персона. Не ещё один промпт. Прослеживаемое понимание того, как на самом деле работает ваш репозиторий, — с уверенностью, актуальностью и приложенными доказательствами.",
    releaseProofEyebrow: "смотрите подтверждения", releaseProofTitle: "Узнайте, что получил агент и что было проверено.",
    releaseProofBody: "Отчёты о задачах показывают переданную память, то, что агент заявляет об её использовании, и результаты правил и команд, которые действительно выполнялись.",
    releaseMetricsAria: "Что различают отчёты о задачах", releaseRevision: "передано", releaseDeclaration: "память, которую Hunch предоставил для этой задачи", releaseConfidence: "заявлено", releaseFile: "то, что агент, по его словам, применил", releaseEvidence: "проверено", releaseInspection: "результаты правил и команд хранятся как отдельные свидетельства",
    releaseCaveat: "Один успешный тест не доказывает, что результат достигнут благодаря Hunch. Без свидетельств результат остаётся непроверенным. <a href=\"/docs#task-reports\">Читать отчёт о задаче →</a>",
    storyEyebrow: "недостающий контекст", storyTitle: "ИИ может прочитать код. Но не видит всей истории.", storyIntro: "Он видит файлы, но не причины решений, прошлые неудачи и то, что может сломать небольшая правка.",
    monday: "Понедельник", monthsLater: "Через несколько месяцев", nextSession: "Следующий сеанс", withHunch: "С Hunch",
    story1Title: "Команда исправляет ошибку выхода из аккаунта.", story1Body: "Данные о входе хранят на сервере, чтобы украденный ключ переставал работать сразу после выхода из аккаунта.",
    story2Title: "Код остаётся. Причина теряется.", story2Body: "Старое обсуждение трудно найти. Более безопасный код теперь кажется излишне сложным.",
    story3Title: "ИИ видит сложный код и «упрощает» его.", story3Body: "Изменение выглядит аккуратно, но возвращает ту же ошибку выхода из аккаунта.",
    story4Title: "Исходная причина доходит до следующего агента.", story4Body: "Если урок записан и интеграция активна, Hunch может показать решение и ошибку, которую оно предотвращает, ещё до правки.",
    receiptAria: "Пример памяти проекта", beforeEditing: "перед изменением", memoryFound: "память найдена", whyExists: "Почему существует этот код",
    logoutTitle: "Выход из аккаунта должен сразу прекращать доступ.", chosen: "выбрано", chosenBody: "Хранить данные о входе на сервере, где доступ можно сразу прекратить.",
    rejected: "отвергнуто", rejectedBody: "Доверять токену входа до истечения его срока действия.",
    protects: "защищает от", protectsBody: "Использования украденного токена после выхода из аккаунта.", receiptFoot: "пример памяти · источник приложен · по умолчанию рекомендация",
    changesEyebrow: "Как работает Hunch", changesTitle: "Помнить. Находить. Проверять.", changesIntro: "Hunch даёт помощнику краткий контекст и инструменты для проверки работы. Планирование и выполнение задачи остаются за помощником.",
    rememberLabel: "01 / помнить", rememberTitle: "Сохраняйте полезную историю.", rememberBody: "Записывайте решения, исправления и наблюдения. Связывайте их с кодом и источниками, чтобы причину можно было найти позже.",
    recallLabel: "02 / находить", recallTitle: "Возвращайте то, что важно.", recallBody: "Выбирайте память для задачи через MCP и поддерживаемые хуки помощников. Охват зависит от интеграции.",
    protectLabel: "03 / проверять", protectTitle: "Проверяйте и показывайте результат.", protectBody: "Проверяйте поддерживаемые правила и сохраняйте отчёт о задаче: переданную память, заявленное использование и наблюдаемые проверки.",
    underEyebrow: "в инструментах для кода", underTitle: "Поймите изменение до того, как его вносить.", underIntro: "Инженерная память связывает причины устройства кода с его зависимостями и правилами, которые команда решила защищать.",
    savedWithGit: "why", codeGraph: "область влияния", mcpRules: "Project DNA", conformance: "compare", provenance: "conform", localFirst: "проверка изменений",
    gitMemoryTitle: "Найдите причину", gitMemoryBody: "Читайте решения, отвергнутые идеи и прошлые сбои, связанные с файлом или символом кода.",
    blastTitle: "Узнайте, что от него зависит", blastBody: "Прослеживайте проиндексированные связи в коде, чтобы понять, на что может повлиять изменение.",
    assistantsTitle: "Изучайте соглашения", assistantsBody: "Изучайте наблюдаемую терминологию и рабочие привычки. Эти наблюдения остаются рекомендациями.",
    checksTitle: "Сравнивайте изменения", checksBody: "Сравнивайте кандидатные ветки с записанными решениями и ограничениями.",
    receiptsTitle: "Проверяйте записанный замысел", receiptsBody: "Проверяйте поддерживаемые связи в коде: например, вызывает ли путь оплаты проверку полномочий по-прежнему.",
    yoursTitle: "Защищайте доверенные правила", yoursBody: "Отмечайте конфликты с поддерживаемыми правилами. Строгий режим блокирует изменения только там, где это допускают правило и интеграция.",
    shortVersion: "Нужны технические подробности?", explore: "Как работает Hunch →",
    startEyebrow: "начало работы", startTitle: "Начните с репозитория.",
    installTitle: "Установите Hunch", installBody: "Установите CLI и запустите hunch init внутри проекта, для которого нужна память.",
    historyTitle: "Добавьте причины устройства кода", historyBody: "При желании дополните память из недавней истории Git, затем проверьте записанные решения и источники.",
    askTitle: "Подключитесь и спросите", askBody: "Перезапустите помощника и спросите, почему файл устроен именно так. В Codex сначала подтвердите доверие к хукам через /hooks.",
    supportedAria: "Поддерживаемые помощники", installComment: "# установка из npm — требуется Node 22.13+", initComment: "# подключить Hunch к проекту и помощникам", backfillComment: "# при желании изучить последние 90 дней", dnaComment: "# изучить доказательную ДНК репозитория", whyComment: "# спросить, зачем нужен файл",
    copy: "копировать", copied: "скопировано", advisoryNote: "По умолчанию Hunch даёт рекомендации. Для блокировки нужен ваш явный выбор. Чтобы обновиться, запустите <code>hunch update</code>, переподключите помощника и проверьте изменённые команды Codex в <code>/hooks</code>.", pluginPrompt: "Используете Claude Code? Установите плагин:",
    ctaTitle: "Для непрерывной работы разных агентов.", ctaBody: "Цель: обращение клиента превращается в исправление кода и проверенные дальнейшие действия. Общее состояние уже доступно; пилот Sofia проверяет весь процесс передачи работы.",
    about: "Hunch хранит решения, записи о работе и обязательства, которыми агентам нужно делиться.",
    product: "продукт", develop: "разработка", connect: "ссылки", mcpTools: "Инструменты MCP", vscodeExtension: "Расширение VS Code",
    canvasDecision: "решение", canvasBug: "ошибка", canvasRule: "правило", canvasWhy: "почему", canvasReason: "причина найдена до правки", held: "сохранено", blocked: "заблокировано",
  },
  ar: {
    dir: "rtl", ogLocale: "ar",
    title: "Hunch — سجل مشترك لوكلاء الذكاء الاصطناعي",
    description: "تبقى القرارات والعمل المنجز والالتزامات متاحة لوكلاء الذكاء الاصطناعي مع مصادرها. ذاكرة هندسية مبنية على Git وخادم حالة تستضيفه بنفسك.",
    ogDescription: "أساس مشترك لعمل الوكلاء: قرارات المشروع وسجلات الإجراءات والالتزامات، مع المصادر وقواعد واضحة للتحديث.",
    mainNav: "التنقّل الرئيسي", language: "اللغة",
    thesisTag: "الحالة الحتمية", thesisText: "ما معنى الحالة الحتمية، بكلمات بسيطة.", thesisCta: "اقرأ الأطروحة ←",
    navHow: "كيف يعمل", navInside: "ما وراء الواجهة", docs: "الوثائق", blog: "المدوّنة", changelog: "سجل التغييرات",
    getStarted: "ابدأ الآن", seeHow: "شاهد كيف يعمل", readDocs: "اقرأ الوثائق", benchmark: "اختبار الأداء",
    releaseEyebrow: "الحمض النووي للمشروع لوكلاء البرمجة بالذكاء الاصطناعي", moatEyebrow: "متاح اليوم", moatTitle: "حافظ على استمرارية العمل بين الجلسات.", moatIntro: "يحفظ Hunch سجلات منظّمة في Git. تصفّحها في المتصفح أو صِل الوكلاء عبر MCP أو HTTP أو سطر الأوامر أو TypeScript أو Python.", moat1Code: "الذاكرة", moat1Title: "احتفظ بالأسباب", moat1Body: "احفظ القرارات والأساليب المرفوضة والأخطاء والأسئلة المفتوحة إلى جانب الشيفرة التي تفسّرها.", moat2Code: "القرارات", moat2Title: "اجعل التغييرات واضحة", moat2Body: "تُرفض القرارات الحالية المتعارضة. وعند استبدال قرار، يبقى سجل بما تغيّر.", moat3Code: "الوصول", moat3Title: "شارك مع الوكلاء المناسبين", moat3Body: "اختر الوكلاء المسموح لهم بالوصول إلى القسم، ثم قيّد الوصول إلى سجلات محددة عند الحاجة. ويمكن ربط بيانات الاعتماد بمفتاح لتوقيع كل طلب.", moat4Code: "الإجراءات", moat4Title: "تابع ما أُنجز وما تبقّى", moat4Body: "راجع العمل المنجز والالتزامات المفتوحة والمصادر المشار إليها في المتصفح. ويحتفظ العمل المجهول أو غير المتحقق منه بهذه الحالة.", moat5Code: "التحكم", moat5Title: "اختر ما يصبح قاعدة", moat5Body: "سجّل أعراف المستخدم والفريق والمؤسسة مع مصادرها. تبقى إرشادية؛ ويتطلب الحظر قاعدة موثوقة صراحة وتفعيل الوضع الصارم.", moat6Code: "git", moat6Title: "احتفظ بملكية السجل", moat6Body: "السجلات ملفات قابلة للقراءة. يتيح Git مراجعة التغييرات المحفوظة في commits والتراجع عنها؛ ويمكن إعادة بناء الفهارس.", heroTitle: "امنح كل وكيل<br /><b>سجلًا مشتركًا يستند إليه.</b>",
    heroLede: "يحفظ Hunch القرارات والعمل المنجز والالتزامات مع مصادرها. ابدأ بذاكرة هندسية لوكلاء البرمجة، أو اربط الوكلاء بخادم حالة تستضيفه بنفسك.",
    heroNote: "ليس شخصية مصطنعة. وليس مطالبة أخرى. بل فهم قابل للتتبّع لكيفية عمل مستودعك فعلًا، مرفق بدرجة الثقة والحداثة والأدلة.",
    releaseProofEyebrow: "اطّلع على الأدلة", releaseProofTitle: "اعرف ما وصل إلى الوكيل وما جرى التحقق منه.",
    releaseProofBody: "تعرض تقارير المهام الذاكرة المقدّمة وما يقول الوكيل إنه استخدمه، ونتائج القواعد والأوامر التي نُفّذت فعلًا.",
    releaseMetricsAria: "ما تميّز بينه تقارير المهام", releaseRevision: "مقدّم", releaseDeclaration: "الذاكرة التي قدّمها Hunch لهذه المهمة", releaseConfidence: "مُبلّغ عنه", releaseFile: "ما يقول الوكيل إنه طبّقه", releaseEvidence: "مفحوص", releaseInspection: "نتائج القواعد والأوامر محفوظة كأدلة منفصلة",
    releaseCaveat: "نجاح اختبار وحده لا يثبت أن Hunch سبّب النتيجة. عند غياب الأدلة، يبقى الأمر غير متحقق منه. <a href=\"/docs#task-reports\">اقرأ تقرير مهمة →</a>",
    storyEyebrow: "السياق المفقود", storyTitle: "يستطيع الذكاء الاصطناعي قراءة الشيفرة. لكنه لا يرى القصة كاملة.", storyIntro: "يرى الملفات، لكنه لا يرى أسباب القرارات أو ما أخفق سابقًا أو ما قد يعطّله تغيير صغير.",
    monday: "يوم الاثنين", monthsLater: "بعد أشهر", nextSession: "الجلسة التالية", withHunch: "مع Hunch",
    story1Title: "يصلح الفريق خطأً في تسجيل الخروج.", story1Body: "يحتفظ الفريق بحالة تسجيل الدخول على الخادم، ليتوقف المفتاح المسروق عن العمل فور تسجيل الخروج.",
    story2Title: "تبقى الشيفرة. ويضيع السبب.", story2Body: "يصعب العثور على النقاش القديم. وتبدو الشيفرة الأكثر أمانًا الآن أعقد من اللازم.",
    story3Title: "يرى الذكاء الاصطناعي شيفرة معقدة فيُبسّطها.", story3Body: "يبدو التغيير مرتبًا، لكنه يعيد الخطأ نفسه في تسجيل الخروج.",
    story4Title: "يصل السبب الأصلي إلى الوكيل التالي.", story4Body: "عندما يكون الدرس مسجّلًا والتكامل نشطًا، يستطيع Hunch عرض القرار والخطأ الذي يمنعه قبل التعديل.",
    receiptAria: "مثال على ذاكرة المشروع", beforeEditing: "قبل تعديل", memoryFound: "عُثر على ذاكرة", whyExists: "لماذا توجد هذه الشيفرة",
    logoutTitle: "يجب أن ينهي تسجيل الخروج الوصول فورًا.", chosen: "المختار", chosenBody: "الاحتفاظ بحالة تسجيل الدخول على الخادم، حيث يمكن إنهاؤها فورًا.",
    rejected: "المرفوض", rejectedBody: "الثقة برمز تسجيل الدخول حتى تنتهي صلاحيته.",
    protects: "يحمي من", protectsBody: "استخدام رمز مسروق بعد تسجيل الخروج.", receiptFoot: "ذاكرة توضيحية · المصدر مرفق · إرشادية افتراضيًا",
    changesEyebrow: "كيف يعمل Hunch", changesTitle: "تذكّر. استرجع. تحقّق.", changesIntro: "يقدّم Hunch للمساعد ملخصًا مركّزًا وأدوات للتحقق من عمله. ويظل المساعد مسؤولًا عن تخطيط المهمة وتنفيذها.",
    rememberLabel: "01 / تذكّر", rememberTitle: "احفظ التاريخ المفيد.", rememberBody: "سجّل القرارات والتصحيحات والملاحظات. واربطها بالشيفرة والمصادر ليسهل العثور على السبب لاحقًا.",
    recallLabel: "02 / استرجع", recallTitle: "استعد ما يهم.", recallBody: "اختر الذاكرة الملائمة للمهمة عبر MCP وخطافات المساعد المدعومة. يعتمد نطاق التغطية على التكامل.",
    protectLabel: "03 / تحقّق", protectTitle: "تحقّق واعرض النتيجة.", protectBody: "قيّم القواعد المدعومة واحتفظ بتقرير للمهمة يميّز بين الذاكرة المقدّمة والاستخدام المُبلّغ عنه والفحوص المرصودة.",
    underEyebrow: "داخل أدوات البرمجة", underTitle: "افهم التغيير قبل تنفيذه.", underIntro: "تربط الذاكرة الهندسية أسباب بناء الشيفرة باعتمادياتها والقواعد التي اختار الفريق حمايتها.",
    savedWithGit: "why", codeGraph: "نطاق التأثير", mcpRules: "Project DNA", conformance: "compare", provenance: "conform", localFirst: "بوابة التغييرات",
    gitMemoryTitle: "اعثر على السبب", gitMemoryBody: "اقرأ القرارات والأفكار المرفوضة والإخفاقات السابقة المرتبطة بملف أو رمز برمجي.",
    blastTitle: "اعرف ما يعتمد عليه", blastBody: "تتبّع العلاقات المفهرسة في الشيفرة لفهم ما قد يتأثر بالتغيير.",
    assistantsTitle: "تعرّف على الأعراف", assistantsBody: "افحص المصطلحات وعادات العمل المرصودة. تبقى هذه الملاحظات إرشادية.",
    checksTitle: "قارن التغييرات", checksBody: "قارن الفروع المرشحة بالقرارات والقيود المسجّلة.",
    receiptsTitle: "تحقّق من القصد المسجّل", receiptsBody: "افحص علاقات الشيفرة المدعومة، مثل ما إذا كان مسار الدفع لا يزال يستدعي التحقق من الصلاحيات.",
    yoursTitle: "احمِ القواعد الموثوقة", yoursBody: "حدّد التعارضات مع القواعد المدعومة. يحظر الوضع الصارم التغييرات فقط حيث تسمح القاعدة والتكامل بذلك.",
    shortVersion: "هل تريد التفاصيل التقنية؟", explore: "اقرأ كيف يعمل Hunch ←",
    startEyebrow: "ابدأ", startTitle: "ابدأ من مستودع.",
    installTitle: "ثبّت Hunch", installBody: "ثبّت أداة CLI وشغّل hunch init داخل المشروع الذي تريد الاحتفاظ بذاكرته.",
    historyTitle: "أضف الأسباب وراء الشيفرة", historyBody: "يمكنك إثراء الذاكرة بتاريخ Git الحديث، ثم مراجعة القرارات والمصادر المسجّلة.",
    askTitle: "اربط المساعد واسأل", askBody: "أعد تحميل المساعد واسأله لماذا بُني ملف بهذه الطريقة. في Codex، أكّد الثقة بالخطافات أولًا عبر /hooks.",
    supportedAria: "المساعدون المدعومون", installComment: "# التثبيت من npm — يتطلب Node 22.13+", initComment: "# ربط Hunch بالمشروع والمساعدين", backfillComment: "# تعلّم اختياري من آخر 90 يومًا", dnaComment: "# افحص الحمض النووي القائم على أدلة المستودع", whyComment: "# اسأل عن سبب وجود ملف",
    copy: "نسخ", copied: "تم النسخ", advisoryNote: "يقدّم Hunch إرشادات افتراضيًا. يتطلب الحظر اختيارك الصريح. للتحديث، شغّل <code>hunch update</code>، وأعد ربط المساعد، وراجع أوامر Codex التي تغيّرت في <code>/hooks</code>.", pluginPrompt: "تستخدم Claude Code؟ ثبّته كإضافة بدلًا من ذلك:",
    ctaTitle: "مصمّم لاستمرارية العمل بين الوكلاء.", ctaBody: "الهدف: تتحول مشكلة عميل إلى إصلاح في الشيفرة ومتابعة جرى التحقق منها. الحالة المشتركة متاحة اليوم؛ ويختبر مشروع Sofia التجريبي انتقال العمل كاملًا بين الوكلاء.",
    about: "يحفظ Hunch القرارات وسجلات العمل والالتزامات التي يحتاج الوكلاء إلى مشاركتها.",
    product: "المنتج", develop: "التطوير", connect: "روابط", mcpTools: "أدوات MCP", vscodeExtension: "إضافة VS Code",
    canvasDecision: "قرار", canvasBug: "خطأ", canvasRule: "قاعدة", canvasWhy: "لماذا", canvasReason: "استُعيد السبب قبل التعديل", held: "محفوظ", blocked: "محظور",
  },
  es: {
    dir: "ltr", ogLocale: "es_ES",
    title: "Hunch — Un registro compartido para agentes de IA",
    description: "Mantén las decisiones, el trabajo realizado y los compromisos al alcance de los agentes de IA, con sus fuentes. Memoria de ingeniería basada en Git y un servidor de estado que puedes alojar tú mismo.",
    ogDescription: "Una base común para el trabajo de los agentes: decisiones del proyecto, registros de acciones y compromisos, con fuentes y reglas claras para las actualizaciones.",
    mainNav: "Navegación principal", language: "Idioma",
    thesisTag: "Estado determinista", thesisText: "Qué significa estado determinista, en palabras sencillas.", thesisCta: "Leer la tesis →",
    navHow: "Cómo funciona", navInside: "Cómo está hecho", docs: "Documentación", blog: "Blog", changelog: "Cambios",
    getStarted: "Empezar", seeHow: "Ver cómo funciona", readDocs: "Leer la documentación", benchmark: "Benchmark",
    releaseEyebrow: "ADN del proyecto para agentes de programación con IA", moatEyebrow: "disponible hoy", moatTitle: "Mantén la continuidad entre sesiones.", moatIntro: "Hunch guarda registros estructurados en Git. Consúltalos en el navegador o conecta agentes mediante MCP, HTTP, la CLI, TypeScript o Python.", moat1Code: "memoria", moat1Title: "Conserva los motivos", moat1Body: "Guarda decisiones, enfoques descartados, errores y preguntas abiertas junto al código que explican.", moat2Code: "decisiones", moat2Title: "Haz explícitos los cambios", moat2Body: "Las decisiones vigentes que entran en conflicto se rechazan. Al reemplazar una decisión queda un historial de lo que cambió.", moat3Code: "acceso", moat3Title: "Comparte con los agentes adecuados", moat3Body: "Elige qué agentes pueden acceder a una partición y restringe registros concretos cuando sea necesario. Las credenciales vinculadas a una clave permiten exigir la firma de cada petición.", moat4Code: "acciones", moat4Title: "Sigue lo hecho y lo pendiente", moat4Body: "Consulta el trabajo terminado, los compromisos pendientes y las fuentes citadas en el navegador. Los resultados desconocidos o sin verificar conservan ese estado.", moat5Code: "control", moat5Title: "Elige qué se convierte en regla", moat5Body: "Registra convenciones del usuario, equipo y organización con sus fuentes. Siguen siendo orientativas; bloquear requiere una regla de confianza explícita y el modo estricto.", moat6Code: "git", moat6Title: "El registro sigue siendo tuyo", moat6Body: "Los registros son archivos legibles. Git permite revisar y revertir cambios guardados en commits; los índices se pueden reconstruir.", heroTitle: "Dale a cada agente<br /><b>un registro compartido para trabajar.</b>",
    heroLede: "Hunch guarda decisiones, trabajo realizado y compromisos junto con sus fuentes. Empieza con memoria de ingeniería para agentes de código o conecta agentes a un servidor de estado alojado por ti.",
    heroNote: "No es una personalidad. No es otro prompt. Es una comprensión trazable de cómo funciona de verdad tu repositorio, con confianza, vigencia y evidencia adjuntas.",
    releaseProofEyebrow: "consulta las pruebas", releaseProofTitle: "Mira qué recibió el agente y qué se comprobó.",
    releaseProofBody: "Los informes de tarea muestran la memoria entregada, lo que el agente dice haber usado y los resultados de las reglas y los comandos que realmente se ejecutaron.",
    releaseMetricsAria: "Qué distinguen los informes de tarea", releaseRevision: "entregado", releaseDeclaration: "la memoria que Hunch proporcionó a esta tarea", releaseConfidence: "declarado", releaseFile: "lo que el agente dice haber aplicado", releaseEvidence: "comprobado", releaseInspection: "resultados de reglas y comandos guardados como pruebas separadas",
    releaseCaveat: "Una prueba superada por sí sola no demuestra que Hunch haya causado el resultado. Lo que carece de pruebas sigue sin verificar. <a href=\"/docs#task-reports\">Lee un informe de tarea →</a>",
    storyEyebrow: "el contexto que falta", storyTitle: "La IA puede leer tu código. No puede ver toda la historia.", storyIntro: "Ve archivos, pero no por qué se tomaron las decisiones, qué falló antes o qué podría romper un pequeño cambio.",
    monday: "Lunes", monthsLater: "Meses después", nextSession: "Siguiente sesión", withHunch: "Con Hunch",
    story1Title: "Tu equipo corrige un error al cerrar sesión.", story1Body: "Guardan las sesiones en el servidor para que una clave robada deje de funcionar en cuanto se cierra la sesión.",
    story2Title: "El código sigue ahí. El motivo se pierde.", story2Body: "La conversación antigua es difícil de encontrar. El código más seguro ahora parece más complicado de lo necesario.",
    story3Title: "La IA ve código complejo y lo «simplifica».", story3Body: "El cambio parece limpio, pero trae de vuelta el mismo error al cerrar sesión.",
    story4Title: "El motivo original llega al siguiente agente.", story4Body: "Con la lección registrada y la integración activa, Hunch puede mostrar la decisión y el error que evita antes de editar.",
    receiptAria: "Ejemplo de memoria del proyecto", beforeEditing: "antes de editar", memoryFound: "memoria encontrada", whyExists: "Por qué existe este código",
    logoutTitle: "Cerrar sesión debe poner fin al acceso de inmediato.", chosen: "elegido", chosenBody: "Guardar las sesiones en el servidor, donde pueden cerrarse al instante.",
    rejected: "descartado", rejectedBody: "Confiar en un token de acceso hasta que caduque.",
    protects: "protege de", protectsBody: "El uso de un token robado después de cerrar sesión.", receiptFoot: "memoria de ejemplo · fuente incluida · orientativa por defecto",
    changesEyebrow: "Cómo funciona Hunch", changesTitle: "Recordar. Recuperar. Comprobar.", changesIntro: "Hunch ofrece al asistente un resumen centrado en la tarea y herramientas para comprobar su trabajo. El asistente sigue planificando y ejecutando la tarea.",
    rememberLabel: "01 / recordar", rememberTitle: "Guarda el historial útil.", rememberBody: "Registra decisiones, correcciones y hallazgos. Vincúlalos al código y a sus fuentes para poder encontrar el motivo más adelante.",
    recallLabel: "02 / recuperar", recallTitle: "Recupera lo que importa.", recallBody: "Selecciona memoria relevante para una tarea mediante MCP y los hooks compatibles del asistente. La cobertura depende de la integración.",
    protectLabel: "03 / comprobar", protectTitle: "Comprueba y muestra el resultado.", protectBody: "Evalúa las reglas compatibles y guarda un informe de tarea con la memoria entregada, el uso declarado y las comprobaciones observadas.",
    underEyebrow: "dentro de las herramientas de código", underTitle: "Entiende un cambio antes de hacerlo.", underIntro: "La memoria de ingeniería conecta los motivos del código con sus dependencias y las reglas que el equipo decidió proteger.",
    savedWithGit: "why", codeGraph: "alcance del cambio", mcpRules: "Project DNA", conformance: "compare", provenance: "conform", localFirst: "control de cambios",
    gitMemoryTitle: "Encuentra el motivo", gitMemoryBody: "Lee las decisiones, las ideas descartadas y los fallos anteriores que explican un archivo o un símbolo del código.",
    blastTitle: "Mira qué depende de él", blastBody: "Sigue las relaciones indexadas del código para entender qué podría verse afectado por un cambio.",
    assistantsTitle: "Conoce las convenciones", assistantsBody: "Consulta la terminología y los hábitos de trabajo observados. Estas observaciones siguen siendo orientativas.",
    checksTitle: "Compara cambios", checksBody: "Compara ramas candidatas con las decisiones y restricciones registradas.",
    receiptsTitle: "Comprueba la intención registrada", receiptsBody: "Comprueba relaciones de código compatibles, como si un flujo de pago sigue llamando a la comprobación de autorización.",
    yoursTitle: "Protege las reglas de confianza", yoursBody: "Detecta conflictos con las reglas compatibles. El modo estricto solo bloquea donde la regla y la integración lo permiten.",
    shortVersion: "¿Quieres los detalles técnicos?", explore: "Lee cómo funciona Hunch →",
    startEyebrow: "primeros pasos", startTitle: "Empieza en un repositorio.",
    installTitle: "Instala Hunch", installBody: "Instala la CLI y ejecuta hunch init dentro del proyecto que quieras que recuerde.",
    historyTitle: "Añade los motivos del código", historyBody: "Si quieres, incorpora el historial reciente de Git y después revisa las decisiones y fuentes registradas.",
    askTitle: "Conecta y pregunta", askBody: "Recarga el asistente y pregunta por qué un archivo está construido así. En Codex, primero confirma la confianza en los hooks mediante /hooks.",
    supportedAria: "Asistentes compatibles", installComment: "# instalación desde npm — requiere Node 22.13+", initComment: "# conecta Hunch al proyecto y a tus asistentes", backfillComment: "# aprende opcionalmente de los últimos 90 días", dnaComment: "# inspecciona el ADN del repositorio basado en evidencia", whyComment: "# pregunta para qué sirve un archivo",
    copy: "copiar", copied: "copiado", advisoryNote: "Hunch ofrece orientación por defecto. El bloqueo requiere tu elección explícita. Para actualizar, ejecuta <code>hunch update</code>, vuelve a conectar el asistente y revisa los comandos de Codex que hayan cambiado en <code>/hooks</code>.", pluginPrompt: "¿Usas Claude Code? Instálalo como plugin:",
    ctaTitle: "Creado para dar continuidad al trabajo entre agentes.", ctaBody: "El objetivo: una incidencia de un cliente se convierte en una corrección de código y un seguimiento verificado. El estado compartido ya está disponible; el piloto Sofia está probando el proceso completo de traspaso del trabajo.",
    about: "Hunch conserva las decisiones, los registros de trabajo y los compromisos que los agentes necesitan compartir.",
    product: "producto", develop: "desarrollo", connect: "enlaces", mcpTools: "Herramientas MCP", vscodeExtension: "Extensión de VS Code",
    canvasDecision: "decisión", canvasBug: "error", canvasRule: "regla", canvasWhy: "por qué", canvasReason: "razón recuperada antes de editar", held: "conservado", blocked: "bloqueado",
  },
};

function escAttr(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function fragments(c) {
  return [
    ["<title>Hunch — A shared record for AI agents</title>", `<title>${c.title}</title>`],
    ["content=\"Keep decisions, completed work, and commitments available to AI agents, with their sources. Git-native engineering memory and a self-hosted state server.\"", `content="${escAttr(c.description)}"`],
    ["<meta property=\"og:title\" content=\"Hunch — A shared record for AI agents\" />", `<meta property="og:title" content="${escAttr(c.title)}" />`],
    ["content=\"Give agents a shared record to work from: project decisions, action records, and commitments, with sources and clear rules for updates.\"", `content="${escAttr(c.ogDescription)}"`],
    ['<span class="thesis-tag">Deterministic State</span>', `<span class="thesis-tag">${c.thesisTag}</span>`],
    ['<span class="thesis-text">What deterministic state means, in plain words.</span>', `<span class="thesis-text">${c.thesisText}</span>`],
    ['<b class="thesis-cta">Read the thesis →</b>', `<b class="thesis-cta">${c.thesisCta}</b>`],
    ['<nav class="nav" aria-label="Main">', `<nav class="nav" aria-label="${escAttr(c.mainNav)}">`],
    ['<span class="sr-only">Language</span>', `<span class="sr-only">${c.language}</span>`],
    ['aria-label="Language"', `aria-label="${escAttr(c.language)}"`],
    [">How it works<", `>${c.navHow}<`], [">Under the hood<", `>${c.navInside}<`], [">Docs<", `>${c.docs}<`], [">Blog<", `>${c.blog}<`], [">Changelog<", `>${c.changelog}<`],
    [">Get started<", `>${c.getStarted}<`], [">See how it works<", `>${c.seeHow}<`], [">Read the docs<", `>${c.readDocs}<`], [">Benchmark<", `>${c.benchmark}<`],
    ["<h1 class=\"rise d1\">Give every agent<br /><b>a shared record to work from.</b></h1>", `<h1 class="rise d1">${c.heroTitle}</h1>`],
    ["<p class=\"lede rise d2\">Hunch keeps decisions, completed work, and commitments with their sources. Start with engineering memory for coding agents, or connect agents to a self-hosted state server.</p>", `<p class="lede rise d2">${c.heroLede}</p>`],
    ["<span class=\"eyebrow\">available today</span>", `<span class="eyebrow">${c.moatEyebrow}</span>`], ["<h2>Keep the work connected across sessions.</h2>", `<h2>${c.moatTitle}</h2>`],
    ["<p>Hunch keeps structured records in Git. Inspect them in a browser or connect agents through MCP, HTTP, the CLI, TypeScript or Python.</p>", `<p>${c.moatIntro}</p>`],
    ["<article class=\"tech-item\"><code>memory</code><h3>Keep the reasons</h3><p>Save decisions, rejected approaches, bugs, and open questions alongside the code they explain.</p></article>", `<article class="tech-item"><code>${c.moat1Code}</code><h3>${c.moat1Title}</h3><p>${c.moat1Body}</p></article>`],
    ["<article class=\"tech-item\"><code>decisions</code><h3>Make changes explicit</h3><p>Conflicting current decisions are refused. Replacing a decision leaves a history of what changed.</p></article>", `<article class="tech-item"><code>${c.moat2Code}</code><h3>${c.moat2Title}</h3><p>${c.moat2Body}</p></article>`],
    ["<article class=\"tech-item\"><code>access</code><h3>Share with the right agents</h3><p>Choose which agents can access a partition, then narrow access to individual records when needed. Optional key-bound credentials add request signing.</p></article>", `<article class="tech-item"><code>${c.moat3Code}</code><h3>${c.moat3Title}</h3><p>${c.moat3Body}</p></article>`],
    ["<article class=\"tech-item\"><code>actions</code><h3>Track done and still to do</h3><p>Inspect completed work, open commitments and cited sources in the browser. Unknown or unverified work keeps that status.</p></article>", `<article class="tech-item"><code>${c.moat4Code}</code><h3>${c.moat4Title}</h3><p>${c.moat4Body}</p></article>`],
    ["<article class=\"tech-item\"><code>control</code><h3>Choose what becomes a rule</h3><p>Record sourced user, team and organization conventions. They stay advisory; blocking requires an explicitly trusted rule and strict mode.</p></article>", `<article class="tech-item"><code>${c.moat5Code}</code><h3>${c.moat5Title}</h3><p>${c.moat5Body}</p></article>`],
    ["<article class=\"tech-item\"><code>git</code><h3>Keep the record yours</h3><p>Records are readable files. Git lets you review and revert committed changes; indexes can be rebuilt.</p></article>", `<article class="tech-item"><code>${c.moat6Code}</code><h3>${c.moat6Title}</h3><p>${c.moat6Body}</p></article>`],
    ["<span class=\"eyebrow\">see the evidence</span>", `<span class="eyebrow">${c.releaseProofEyebrow}</span>`],
    ["<h2 id=\"release-proof-title\">See what reached the agent—and what was checked.</h2>", `<h2 id="release-proof-title">${c.releaseProofTitle}</h2>`],
    ["<p class=\"release-copy\">Task reports show the memory delivered, what the agent says it used, and the results of rules and commands that actually ran.</p>", `<p class="release-copy">${c.releaseProofBody}</p>`],
    ["aria-label=\"What task reports distinguish\"", `aria-label="${escAttr(c.releaseMetricsAria)}"`],
    ["<strong>delivered</strong>", `<strong>${c.releaseRevision}</strong>`],
    ["<span>the memory Hunch supplied to this task</span>", `<span>${c.releaseDeclaration}</span>`],
    ["<strong>reported</strong>", `<strong>${c.releaseConfidence}</strong>`],
    ["<span>what the agent says it applied</span>", `<span>${c.releaseFile}</span>`],
    ["<strong>checked</strong>", `<strong>${c.releaseEvidence}</strong>`],
    ["<span>rule and command results kept as separate evidence</span>", `<span>${c.releaseInspection}</span>`],
    ["<p class=\"release-caveat\">A passing test alone does not prove Hunch caused the result. Missing evidence stays unverified. <a href=\"/docs#task-reports\">Read a task report →</a></p>", `<p class="release-caveat">${c.releaseCaveat}</p>`],
    ['<span class="eyebrow">the missing context</span>', `<span class="eyebrow">${c.storyEyebrow}</span>`],
    ['<h2>AI can read your code. It cannot see the whole story.</h2>', `<h2>${c.storyTitle}</h2>`],
    ['<p>It sees files, not why decisions were made, what failed before, or what a small change could break.</p>', `<p>${c.storyIntro}</p>`],
    ['<span class="story-when">Monday</span>', `<span class="story-when">${c.monday}</span>`],
    ['<span class="story-when">Months later</span>', `<span class="story-when">${c.monthsLater}</span>`],
    ['<span class="story-when">Next session</span>', `<span class="story-when">${c.nextSession}</span>`],
    ['<span class="story-when">With Hunch</span>', `<span class="story-when">${c.withHunch}</span>`],
    ['<h3>Your team fixes a logout bug.</h3>', `<h3>${c.story1Title}</h3>`],
    ['<p>They keep sign-ins on the server so a stolen key stops working as soon as someone logs out.</p>', `<p>${c.story1Body}</p>`],
    ['<h3>The code stays. The reason gets lost.</h3>', `<h3>${c.story2Title}</h3>`],
    ['<p>The old discussion is hard to find. The safer code now looks more complicated than it needs to be.</p>', `<p>${c.story2Body}</p>`],
    ['<h3>AI sees complex code and “simplifies” it.</h3>', `<h3>${c.story3Title}</h3>`],
    ['<p>The change looks clean, but it brings the same logout bug back.</p>', `<p>${c.story3Body}</p>`],
    ["<h3>The original reason reaches the next agent.</h3>", `<h3>${c.story4Title}</h3>`],
    ["<p>With the lesson recorded and the integration active, Hunch can show the decision and the bug it prevents before the edit.</p>", `<p>${c.story4Body}</p>`],
    ["aria-label=\"Example project memory\"", `aria-label="${escAttr(c.receiptAria)}"`],
    ["<div class=\"receipt-head\"><span>before editing · <bdi>src/auth/session.ts</bdi></span><b>memory found</b></div>", `<div class="receipt-head"><span>${c.beforeEditing} · <bdi>src/auth/session.ts</bdi></span><b>${c.memoryFound}</b></div>`],
    ['<span class="receipt-kicker">Why this code exists</span>', `<span class="receipt-kicker">${c.whyExists}</span>`],
    ['<h3>Logging out must end access right away.</h3>', `<h3>${c.logoutTitle}</h3>`],
    ['<div class="receipt-row"><span>chosen</span><p>Keep sign-ins on the server, where they can be ended at once.</p></div>', `<div class="receipt-row"><span>${c.chosen}</span><p>${c.chosenBody}</p></div>`],
    ['<div class="receipt-row"><span>rejected</span><p>Trust a login token until its timer runs out.</p></div>', `<div class="receipt-row"><span>${c.rejected}</span><p>${c.rejectedBody}</p></div>`],
    ['<div class="receipt-row"><span>protects</span><p>A stolen token being used after logout.</p></div>', `<div class="receipt-row"><span>${c.protects}</span><p>${c.protectsBody}</p></div>`],
    ["<p class=\"receipt-foot\">example memory · source included · advisory by default</p>", `<p class="receipt-foot">${c.receiptFoot}</p>`],
    ['<span class="eyebrow">how hunch works</span>', `<span class="eyebrow">${c.changesEyebrow}</span>`],
    ["<h2>Remember. Retrieve. Check.</h2>", `<h2>${c.changesTitle}</h2>`],
    ["<p>Hunch gives the assistant a focused brief and tools to check its work. The assistant still plans and carries out the task.</p>", `<p>${c.changesIntro}</p>`],
    ["<span class=\"step-n\">01 / remember</span>", `<span class="step-n">${c.rememberLabel}</span>`], ["<h3>Save the useful history.</h3>", `<h3>${c.rememberTitle}</h3>`],
    ["<p>Capture decisions, corrections, and findings. Link them to code and sources so the reason remains findable.</p>", `<p>${c.rememberBody}</p>`],
    ["<span class=\"step-n\">02 / retrieve</span>", `<span class="step-n">${c.recallLabel}</span>`], ["<h3>Bring back what matters.</h3>", `<h3>${c.recallTitle}</h3>`],
    ["<p>Select relevant memory for a task through MCP and supported assistant hooks. Coverage depends on the integration.</p>", `<p>${c.recallBody}</p>`],
    ["<span class=\"step-n\">03 / check</span>", `<span class="step-n">${c.protectLabel}</span>`], ["<h3>Check and show the result.</h3>", `<h3>${c.protectTitle}</h3>`],
    ["<p>Evaluate supported rules and keep a task report of delivered memory, reported use, and observed checks.</p>", `<p>${c.protectBody}</p>`],
    ["<span class=\"eyebrow\">inside the coding tools</span>", `<span class="eyebrow">${c.underEyebrow}</span>`], ["<h2>Understand a change before making it.</h2>", `<h2>${c.underTitle}</h2>`],
    ["<p>Engineering memory connects the reasons behind code to its dependencies and the rules the team chose to protect.</p>", `<p>${c.underIntro}</p>`],
    ["<code class=\"literal\">why</code>", `<code class="literal">${c.savedWithGit}</code>`], ["<code>blast radius</code>", `<code>${c.codeGraph}</code>`], ["<code>project DNA</code>", `<code>${c.mcpRules}</code>`], ["<code>compare</code>", `<code>${c.conformance}</code>`], ["<code>conform</code>", `<code>${c.provenance}</code>`], ["<code>change gate</code>", `<code>${c.localFirst}</code>`],
    ["<h3>Find the reason</h3>", `<h3>${c.gitMemoryTitle}</h3>`], ["<p>Read decisions, rejected ideas, and past failures behind a file or symbol.</p>", `<p>${c.gitMemoryBody}</p>`],
    ["<h3>See what depends on it</h3>", `<h3>${c.blastTitle}</h3>`], ["<p>Follow indexed code relationships to understand what a change could affect.</p>", `<p>${c.blastBody}</p>`],
    ["<h3>Learn the conventions</h3>", `<h3>${c.assistantsTitle}</h3>`], ["<p>Inspect observed terminology and working habits. These observations stay advisory.</p>", `<p>${c.assistantsBody}</p>`],
    ["<h3>Compare changes</h3>", `<h3>${c.checksTitle}</h3>`], ["<p>Compare candidate branches against recorded decisions and constraints.</p>", `<p>${c.checksBody}</p>`],
    ["<h3>Check recorded intent</h3>", `<h3>${c.receiptsTitle}</h3>`], ["<p>Check supported code relationships, such as whether a payment path still calls authorization.</p>", `<p>${c.receiptsBody}</p>`],
    ["<h3>Protect trusted rules</h3>", `<h3>${c.yoursTitle}</h3>`], ["<p>Flag conflicts with supported rules. Strict mode blocks only where the rule and integration permit it.</p>", `<p>${c.yoursBody}</p>`],
    ['<p class="tech-link">Want the technical details? <a href="/docs">Read how Hunch works →</a></p>', `<p class="tech-link">${c.shortVersion} <a href="/docs">${c.explore}</a></p>`],
    ['<span class="eyebrow">get started</span>', `<span class="eyebrow">${c.startEyebrow}</span>`], ["<h2>Start in a repository.</h2>", `<h2>${c.startTitle}</h2>`],
    ['<h3>Install Hunch</h3>', `<h3>${c.installTitle}</h3>`], ["<p>Install the CLI and run hunch init inside the project you want it to remember.</p>", `<p>${c.installBody}</p>`],
    ["<h3>Add the reasons behind the code</h3>", `<h3>${c.historyTitle}</h3>`], ["<p>Optionally backfill recent Git history, then review the captured decisions and sources.</p>", `<p>${c.historyBody}</p>`],
    ["<h3>Connect and ask</h3>", `<h3>${c.askTitle}</h3>`], ["<p>Reload your assistant and ask why a file is built this way. In Codex, trust the hooks through /hooks first.</p>", `<p>${c.askBody}</p>`],
    ['aria-label="Supported assistants"', `aria-label="${escAttr(c.supportedAria)}"`],
    ['<span class="c-key"># install from npm — Node 22.13+</span>', `<span class="c-key">${c.installComment}</span>`], ['<span class="c-key"># connect Hunch to this project</span>', `<span class="c-key">${c.initComment}</span>`],
    ['<span class="c-key"># learn from the last 90 days</span>', `<span class="c-key">${c.backfillComment}</span>`], ["<span class=\"c-key\"># see your project's DNA</span>", `<span class="c-key">${c.dnaComment}</span>`], ['<span class="c-key"># ask what a file is for</span>', `<span class="c-key">${c.whyComment}</span>`],
    ['<button class="copybtn" data-copy="#install-cmd">copy</button>', `<button class="copybtn" data-copy="#install-cmd">${c.copy}</button>`],
    ["Hunch gives advice by default. Blocking requires your explicit choice. To update, run <code>hunch update</code>, reconnect the assistant, and review changed Codex commands in <code>/hooks</code>.<br /><br />", `${c.advisoryNote}<br /><br />`],
    ['Claude Code? Install as a plugin instead:<br />', `${c.pluginPrompt}<br />`],
    ["<h2>Built for continuity across agents.</h2>", `<h2>${c.ctaTitle}</h2>`], ["<p>The goal: a customer issue becomes a code fix and a verified follow-up. Shared state ships today; the Sofia pilot is testing the complete handoff.</p>", `<p>${c.ctaBody}</p>`],
    ["<p class=\"about\">Hunch keeps the decisions, work records, and commitments that agents need to share.</p>", `<p class="about">${c.about}</p>`],
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

  const banned = ["Read the thesis", "Agents are probabilistic. Organizations need deterministic state.", "Help AI understand your code", "Your code has DNA", "Hunch learns how your project works", "the missing context", "AI can read your code", "Your team fixes a logout bug", "AI sees complex code", "The right DNA Strand activates first", "how hunch works", "Every task activates the right DNA Strand", "lean by design", "Less context. Better understanding", "right task", "more than context", "A set of tools guides the agent", "Understands why", "Install Hunch", "Install once. Work normally", "Learn the Project DNA", "Hunch gives advice by default", "One project. One DNA"];
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
