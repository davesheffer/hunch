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
    title: "Hunch Memory — Project DNA לעוזרי קוד מבוססי AI",
    description: "למאגר שלכם יש DNA. Hunch נותן לעוזרי קוד מבוססי AI הבנה מבוססת ראיות של הדרך שבה הפרויקט מתקשר ועובד, לפני שהם משנים את הקוד.",
    ogDescription: "כל סוכן קוד מגיע כזר מבריק. Hunch מלמד אותו את השפה, ההחלטות, התיקונים שנלמדו בדרך והגבולות שמאחורי הקוד.",
    mainNav: "ניווט ראשי", language: "שפה",
    thesisTag: "מצב דטרמיניסטי", thesisText: "סוכנים הם הסתברותיים. ארגונים צריכים מצב דטרמיניסטי.", thesisCta: "לקריאת התזה ←",
    navHow: "כך זה עובד", navInside: "מאחורי הקלעים", docs: "תיעוד", blog: "בלוג", changelog: "יומן שינויים",
    getStarted: "מתחילים", seeHow: "כך זה עובד", readDocs: "קריאת התיעוד", benchmark: "מדד ביצועים",
    releaseEyebrow: "Project DNA לעוזרי קוד מבוססי AI", heroTitle: "למאגר שלכם יש DNA.<br /><b>Hunch מלמד כל סוכן קוד איך המאגר עובד.</b>",
    heroLede: "כל סוכן קוד מגיע כשהוא שולט בתחביר, אבל הוא חדש בצוות שלכם. Hunch נותן לו את השפה, ההחלטות, התיקונים שנלמדו בדרך והגבולות שמאחורי הקוד — לפני שהוא משנה אותו.",
    heroNote: "לא פרסונה. לא עוד פרומפט. הבנה ניתנת למעקב של הדרך שבה המאגר באמת עובד — עם רמת ביטחון, עדכניות וראיות מצורפות.",
    releaseProofEyebrow: "Project DNA ב-v1.22", releaseProofTitle: "הבנה מבוססת ראיות, לא תחושות בטן.",
    releaseProofBody: "Hunch בונה פרופיל שמקושר לרוויזיה מסוימת מתוך היסטוריית Git, קובצי מוסכמות וראיות סקירה תחומות. טקסט גולמי מהשיח בצוות אינו נכנס לפרופיל, והרגלים שנצפו לעולם אינם הופכים למדיניות.",
    releaseMetricsAria: "מה נשאר ניתן למעקב ב-Project DNA", releaseRevision: "רוויזיה מדויקת", releaseDeclaration: "הפרופיל נשאר קשור לקוד שהוא מתאר", releaseConfidence: "ביטחון + עדכניות", releaseFile: "כל מאפיין מציין עד כמה ועד מתי הוא נתמך", releaseEvidence: "ראיות חתומות", releaseInspection: "הסוכן יכול להראות למה כל תצפית שייכת",
    releaseCaveat: "Project DNA יכול להנחות התמצאות, מינוח וסקירה. הוא אינו יכול ליצור או לעקוף החלטה, אילוץ, מדיניות או הרשאה. <a href=\"/docs\">כך פועל גבול הראיות ←</a>",
    storyEyebrow: "בעיית הזר המבריק", storyTitle: "הוא מבין את התחביר. הוא לא מבין למה הצוות שלכם אומר לא.", storyIntro: "הקוד נשאר. שיקול הדעת שהצוות רכש בדרך דוהה.",
    monday: "יום שני", monthsLater: "כעבור חודשים", nextSession: "בסשן הבא", withHunch: "עם Hunch",
    story1Title: "הצוות פותר באג התנתקות כואב.", story1Body: "הם מעבירים את הסשנים לשרת כדי שאפשר יהיה לבטל מיד טוקן שדלף. הבחירה מוסיפה מורכבות, אבל סוגרת את הפרצה.",
    story2Title: "הקוד נשאר. ההקשר דוהה.", story2Body: "האירוע קבור ב-pull request ישן. שני אנשים עברו לצוותים אחרים. זרימת הסשן החריגה נראית עכשיו כמו מנגנון מיותר.",
    story3Title: "זר מבריק מציע „לפשט” אותו.", story3Body: "השינוי נקי ונכון מקומית. הוא גם פותח מחדש בדיוק את הכשל שהצוות כבר שילם כדי להבין.",
    story4Title: "המאגר מלמד את הסוכן לפני העריכה.", story4Body: "Hunch מחזיר לקדמת הבמה מה נבחר, מה נדחה ואיזה באג הבחירה מונעת. הסוכן עובד עם שיקול הדעת של הצוות בלי להעמיד פנים שהוא הצוות.",
    receiptAria: "דוגמה לכרטיס זיכרון של הפרויקט", beforeEditing: "לפני עריכת", memoryFound: "נמצא זיכרון", whyExists: "למה הקוד הזה קיים",
    logoutTitle: "התנתקות חייבת לבטל גישה מיד.", chosen: "נבחר", chosenBody: "לשמור סשנים בצד השרת ולאפשר לטוקנים לשאת רק מזהה אטום.",
    rejected: "נדחה", rejectedBody: "סשנים המבוססים רק על JWT; הם נשארים תקפים אחרי התנתקות עד שפג תוקפם.",
    protects: "מגן מפני", protectsBody: "שימוש בטוקן שדלף אחרי שהמשתמש איפס את הסשן שלו.", receiptFoot: "ייעוץ בלבד · עדכני לרוויזיה הזאת · ראיות מצורפות",
    changesEyebrow: "כך Project DNA עובד", changesTitle: "Hunch לומד איך המאגר הזה עובד — ואז נותן לכל סוכן רק את מה שרלוונטי.", changesIntro: "הוא הופך ראיות שכבר נמצאות במאגר להקשר תחום ורלוונטי. הרגלים שנצפו נשארים בגדר עצה; רק כללים שאנשים נותנים בהם אמון במפורש יכולים לקבל סמכות אכיפה.",
    rememberLabel: "01 / להתבונן", rememberTitle: "לקרוא את האותות של המאגר עצמו.", rememberBody: "Hunch בוחן רוויזיית Git מדויקת, היסטוריה תחומה, מוסכמות מחויבות וראיות סקירה שהכלים שלכם מורשים לספק.",
    recallLabel: "02 / להבין", recallTitle: "לבנות תמונה ניתנת למעקב.", recallBody: "השפה, הרגלי התרומה, ציפיות הסקירה והמוסכמות ההנדסיות שומרות את רמת הביטחון, העדכניות והראיות שלהן.",
    protectLabel: "03 / ללמד", protectTitle: "להביא לעבודה את ה-DNA הנכון.", protectBody: "הסוכן מקבל את ההקשר הרלוונטי לפני העריכה. התנהגות נפוצה לעולם אינה הופכת בשקט לכלל, והסמכות נשארת אנושית.",
    underEyebrow: "מה הופך את זה לאמין", underTitle: "לא פרסונה. לא מדיניות נסתרת. ראיות שאפשר לבדוק.", underIntro: "Hunch מפריד בין Project DNA שנצפה, זיכרון הנדסי עמיד וכללים שאושרו בידי אנשים. כל תשובה מציינת מאיפה הגיעה, עד כמה היא עדכנית ואיזו סמכות באמת יש לה.",
    savedWithGit: "Project DNA", codeGraph: "זיכרון הנדסי", mcpRules: "גרף קוד", conformance: "סמכות אנושית", provenance: "ראיות מצורפות", localFirst: "local-first",
    gitMemoryTitle: "לומד איך המאגר מדבר", gitMemoryBody: "אוצר מילים, הרגלי תרומה, ציפיות סקירה ומוסכמות הנדסיות מגיעים מראיות במאגר — לא מאישיות שנוצרה.",
    blastTitle: "זוכר למה הקוד קיים", blastBody: "החלטות, חלופות שנדחו, תיקונים ובאגים שכבר נפתרו נשארים זמינים גם אחרי שהצ'אט, ה-pull request או חבר הצוות נעלמו.",
    assistantsTitle: "יודע על מה שינוי עשוי להשפיע", assistantsBody: "Hunch עוקב אחרי החיבורים בין קבצים ופונקציות כדי שהסיבה הנכונה תופיע במקום הנכון.",
    checksTitle: "לעולם לא הופך פופולריות למדיניות", checksBody: "דפוסים שנצפו נשארים בגדר עצה. רק כלל מדויק שאנשים בוחרים לתת בו אמון יכול לקבל סמכות אכיפה.",
    receiptsTitle: "מראה מאיפה כל טענה הגיעה", receiptsBody: "רמת הביטחון, העדכניות, המקור והרוויזיה התומכת עוברים יחד עם ההקשר שהסוכן מקבל.",
    yoursTitle: "הזיכרון נשאר שלכם", yoursBody: "Hunch לא דורש חשבון מתארח. שמרו את הזיכרון בפרויקט או במאגר Git פרטי שבשליטת הצוות.",
    shortVersion: "רוצים את הפרטים הטכניים?", explore: "כך Hunch עובד ←",
    startEyebrow: "מתחילים", startTitle: "תנו למאגר שלכם להציג את עצמו.",
    installTitle: "התקינו את Hunch", installBody: "פקודה אחת קוראת את הפרויקט ומחברת את עוזרי הקוד שכבר נמצאים בשימוש.",
    historyTitle: "הוסיפו את ההיסטוריה שמסבירה למה", historyBody: "<code>hunch backfill --since 90d</code> מוצא החלטות ולקחים שימושיים ב-90 הימים האחרונים של הקומיטים.",
    askTitle: "ראו מה Hunch למד", askBody: "בדקו את ה-Project DNA שלכם, ואז שאלו <em>„למה מודול הסשן בנוי כך?”</em> כל תשובה מגיעה עם ראיות.",
    supportedAria: "עוזרים נתמכים", installComment: "# התקנה מ-npm — נדרש Node 22.13+", initComment: "# חיבור Hunch לפרויקט ולעוזרים", backfillComment: "# אפשר ללמוד מ-90 הימים האחרונים", dnaComment: "# בדיקת ה-DNA מבוסס הראיות של המאגר", whyComment: "# לשאול למה קובץ קיים",
    copy: "העתקה", copied: "הועתק", advisoryNote: "Project DNA והזיכרון הם בגדר עצה כברירת מחדל. דבר אינו נחסם עד שתבחרו בכך במפורש.", pluginPrompt: "משתמשים ב-Claude Code? התקינו במקום זאת כתוסף:",
    ctaTitle: "למדו כל סוכן קוד איך המאגר שלכם עובד.", ctaBody: "תנו לו את השפה, ההחלטות, הלקחים שנלמדו בדרך והגבולות שמאחורי הקוד לפני שהוא משנה אותו — והשאירו כל טענה ניתנת למעקב.",
    about: "Git שומר את הקוד. Hunch נותן לסוכני קוד את ה-DNA מבוסס הראיות שמסביר איך המאגר עובד ולמה הקוד בנוי כך.",
    product: "מוצר", develop: "פיתוח", connect: "קישורים", mcpTools: "כלי MCP", vscodeExtension: "תוסף ל-VS Code",
    canvasDecision: "החלטה", canvasBug: "באג", canvasRule: "כלל", canvasWhy: "למה", canvasReason: "הסיבה נשלפה לפני העריכה", held: "נשמר", blocked: "נחסם",
  },
  ru: {
    dir: "ltr", ogLocale: "ru_RU",
    title: "Hunch Memory — ДНК проекта для ИИ-агентов по коду",
    description: "У вашего репозитория есть ДНК. Hunch даёт ИИ-агентам доказательное понимание того, как проект общается и работает, до того, как они изменят код.",
    ogDescription: "Каждый агент по коду приходит блестящим незнакомцем. Hunch знакомит его с языком, решениями, выстраданными исправлениями и границами вашего кода.",
    mainNav: "Основная навигация", language: "Язык",
    thesisTag: "Детерминированное состояние", thesisText: "Агенты вероятностны. Организациям нужно детерминированное состояние.", thesisCta: "Читать тезис →",
    navHow: "Как это работает", navInside: "Что внутри", docs: "Документация", blog: "Блог", changelog: "История изменений",
    getStarted: "Начать", seeHow: "Посмотреть, как это работает", readDocs: "Читать документацию", benchmark: "Бенчмарк",
    releaseEyebrow: "ДНК проекта для ИИ-агентов по коду", heroTitle: "У вашего репозитория есть ДНК.<br /><b>Hunch знакомит с ней каждого агента по коду.</b>",
    heroLede: "Каждый агент по коду свободно владеет синтаксисом, но ничего не знает о вашей команде. Hunch даёт ему язык, решения, выстраданные исправления и границы кода до того, как он внесёт изменение.",
    heroNote: "Не персона. Не ещё один промпт. Прослеживаемое понимание того, как на самом деле работает ваш репозиторий, — с уверенностью, актуальностью и приложенными доказательствами.",
    releaseProofEyebrow: "ДНК проекта в v1.22", releaseProofTitle: "Понимание на доказательствах, а не на ощущениях.",
    releaseProofBody: "Hunch строит привязанный к ревизии профиль из истории Git, файлов соглашений и ограниченных доказательств ревью. Сырой текст командного общения в профиль не попадает, а наблюдаемые привычки никогда не становятся политикой.",
    releaseMetricsAria: "Что остаётся прослеживаемым в ДНК проекта", releaseRevision: "точная ревизия", releaseDeclaration: "профиль остаётся привязанным к описываемому коду", releaseConfidence: "уверенность + актуальность", releaseFile: "каждая характеристика показывает силу и свежесть подтверждения", releaseEvidence: "доказательства запечатаны", releaseInspection: "агент может показать основание каждого наблюдения",
    releaseCaveat: "ДНК проекта может помогать с ориентацией, терминологией и ревью. Она не может создать или переопределить решение, ограничение, политику или разрешение. <a href=\"/docs\">Как устроена граница доказательств →</a>",
    storyEyebrow: "проблема блестящего незнакомца", storyTitle: "Он понимает синтаксис. Он не понимает, почему ваша команда говорит «нет».", storyIntro: "Код остаётся. Выстраданное суждение за ним стирается.",
    monday: "Понедельник", monthsLater: "Через несколько месяцев", nextSession: "Следующий сеанс", withHunch: "С Hunch",
    story1Title: "Команда исправляет болезненную ошибку выхода.", story1Body: "Сессии переносят на сервер, чтобы скомпрометированный токен можно было немедленно отозвать. Решение усложняет систему, но закрывает уязвимость.",
    story2Title: "Код остаётся. Контекст стирается.", story2Body: "Инцидент затерялся в старом pull request. Два человека перешли в другие команды. Необычный поток сессии теперь выглядит ненужным усложнением.",
    story3Title: "Блестящий незнакомец предлагает всё «упростить».", story3Body: "Изменение аккуратно и локально корректно. Но оно снова открывает тот самый дефект, за понимание которого команда уже заплатила.",
    story4Title: "Репозиторий учит агента до правки.", story4Body: "Hunch возвращает выбранный и отвергнутый подходы и ошибку, которую предотвращает решение. Агент работает с суждением команды, не выдавая себя за команду.",
    receiptAria: "Пример карточки памяти проекта", beforeEditing: "перед изменением", memoryFound: "память найдена", whyExists: "Почему существует этот код",
    logoutTitle: "Выход должен немедленно отзывать доступ.", chosen: "выбрано", chosenBody: "Хранить сессии на сервере, а в токене оставлять только непрозрачный идентификатор.",
    rejected: "отвергнуто", rejectedBody: "Сессии только на JWT: после выхода они действуют до истечения срока токена.",
    protects: "защищает от", protectsBody: "Использования украденного токена после сброса пользовательской сессии.", receiptFoot: "рекомендация · актуально для этой ревизии · доказательства приложены",
    changesEyebrow: "как работает ДНК проекта", changesTitle: "Hunch изучает, как работает этот репозиторий, — и даёт каждому агенту только нужное.", changesIntro: "Он превращает уже имеющиеся в репозитории доказательства в ограниченный релевантный контекст. Наблюдаемые привычки остаются советом; правом на принуждение обладают только правила, которым люди явно доверили такую роль.",
    rememberLabel: "01 / наблюдать", rememberTitle: "Читайте сигналы самого репозитория.", rememberBody: "Hunch изучает точную ревизию Git, ограниченную историю, зафиксированные соглашения и доказательства ревью, которые ваши инструменты уполномочены предоставить.",
    recallLabel: "02 / понять", recallTitle: "Постройте прослеживаемую картину.", recallBody: "Язык, привычки внесения изменений, ожидания от ревью и инженерные соглашения сохраняют свою уверенность, актуальность и доказательства.",
    protectLabel: "03 / научить", protectTitle: "Передайте работе нужную ДНК.", protectBody: "Агент получает релевантный контекст до правки. Распространённое поведение никогда не становится правилом исподволь, а власть остаётся у людей.",
    underEyebrow: "почему этому можно доверять", underTitle: "Не персона. Не невидимая политика. Доказательства, которые можно проверить.", underIntro: "Hunch разделяет наблюдаемую ДНК проекта, долговременную инженерную память и правила, одобренные людьми. Каждый ответ показывает свой источник, актуальность и реальный уровень полномочий.",
    savedWithGit: "ДНК проекта", codeGraph: "инженерная память", mcpRules: "граф кода", conformance: "власть людей", provenance: "доказательства приложены", localFirst: "local-first",
    gitMemoryTitle: "Узнаёт, как говорит репозиторий", gitMemoryBody: "Словарь, привычки внесения изменений, ожидания от ревью и инженерные соглашения выводятся из доказательств репозитория, а не из сгенерированной личности.",
    blastTitle: "Помнит, зачем существует код", blastBody: "Решения, отвергнутые подходы, исправления и закрытые ошибки остаются доступными после исчезновения чата, pull request или коллеги.",
    assistantsTitle: "Знает, на что может повлиять изменение", assistantsBody: "Hunch следует связям между файлами и функциями, чтобы нужная причина появилась в нужном месте.",
    checksTitle: "Не превращает популярность в политику", checksBody: "Наблюдаемые шаблоны остаются рекомендациями. Полномочия на принуждение может получить только точное правило, которому люди осознанно доверяют.",
    receiptsTitle: "Показывает источник каждого утверждения", receiptsBody: "Уверенность, актуальность, происхождение и подтверждающая ревизия передаются вместе с контекстом для агента.",
    yoursTitle: "Ваша память остаётся вашей", yoursBody: "Hunch не требует облачного аккаунта. Храните память в проекте или в приватном Git-репозитории команды.",
    shortVersion: "Нужны технические подробности?", explore: "Как работает Hunch →",
    startEyebrow: "начало работы", startTitle: "Позвольте репозиторию представиться.",
    installTitle: "Установите Hunch", installBody: "Одна команда читает проект и подключает помощников по коду, которыми вы уже пользуетесь.",
    historyTitle: "Добавьте историю, которая объясняет почему", historyBody: "<code>hunch backfill --since 90d</code> находит полезные решения и уроки в коммитах за последние 90 дней.",
    askTitle: "Посмотрите, что узнал Hunch", askBody: "Изучите ДНК проекта, затем спросите: <em>«Почему модуль сессий устроен именно так?»</em> Каждый ответ приходит с доказательствами.",
    supportedAria: "Поддерживаемые помощники", installComment: "# установка из npm — требуется Node 22.13+", initComment: "# подключить Hunch к проекту и помощникам", backfillComment: "# при желании изучить последние 90 дней", dnaComment: "# изучить доказательную ДНК репозитория", whyComment: "# спросить, зачем нужен файл",
    copy: "копировать", copied: "скопировано", advisoryNote: "ДНК проекта и память по умолчанию носят рекомендательный характер. Ничто не блокируется, пока вы явно не включите это.", pluginPrompt: "Используете Claude Code? Установите плагин:",
    ctaTitle: "Научите каждого агента тому, как работает ваш репозиторий.", ctaBody: "Передайте ему язык, решения, выстраданные уроки и границы кода до изменения — и сохраните каждое утверждение прослеживаемым.",
    about: "Git хранит код. Hunch даёт агентам доказательную ДНК, которая объясняет, как работает репозиторий и почему код устроен именно так.",
    product: "продукт", develop: "разработка", connect: "ссылки", mcpTools: "Инструменты MCP", vscodeExtension: "Расширение VS Code",
    canvasDecision: "решение", canvasBug: "ошибка", canvasRule: "правило", canvasWhy: "почему", canvasReason: "причина найдена до правки", held: "сохранено", blocked: "заблокировано",
  },
  ar: {
    dir: "rtl", ogLocale: "ar",
    title: "Hunch Memory — الحمض النووي للمشروع لوكلاء البرمجة بالذكاء الاصطناعي",
    description: "لمستودعك حمض نووي. يمنح Hunch وكلاء البرمجة فهمًا قائمًا على الأدلة لكيفية تواصل المشروع وعمله قبل أن يغيّروا الشيفرة.",
    ogDescription: "يصل كل وكيل برمجي غريبًا لامعًا. يعرّفه Hunch على لغة شيفرتك وقراراتها وإصلاحاتها الصعبة وحدودها.",
    mainNav: "التنقّل الرئيسي", language: "اللغة",
    thesisTag: "الحالة الحتمية", thesisText: "الوكلاء احتماليون. المؤسسات تحتاج حالة حتمية.", thesisCta: "اقرأ الأطروحة ←",
    navHow: "كيف يعمل", navInside: "ما وراء الواجهة", docs: "الوثائق", blog: "المدوّنة", changelog: "سجل التغييرات",
    getStarted: "ابدأ الآن", seeHow: "شاهد كيف يعمل", readDocs: "اقرأ الوثائق", benchmark: "اختبار الأداء",
    releaseEyebrow: "الحمض النووي للمشروع لوكلاء البرمجة بالذكاء الاصطناعي", heroTitle: "لمستودعك حمض نووي.<br /><b>ويمنح Hunch كل وكيل برمجي فهمًا له.</b>",
    heroLede: "يصل كل وكيل برمجي متقنًا لبناء الجملة لكنه جديد على فريقك. يمنحه Hunch اللغة والقرارات والإصلاحات الصعبة والحدود الكامنة خلف الشيفرة قبل أن يغيّرها.",
    heroNote: "ليس شخصية مصطنعة. وليس مطالبة أخرى. بل فهم قابل للتتبّع لكيفية عمل مستودعك فعلًا، مرفق بدرجة الثقة والحداثة والأدلة.",
    releaseProofEyebrow: "الحمض النووي للمشروع في v1.22", releaseProofTitle: "فهم قائم على الأدلة، لا على الانطباعات.",
    releaseProofBody: "يبني Hunch ملفًا مرتبطًا بمراجعة محددة من تاريخ Git وملفات الأعراف وأدلة المراجعة المحدودة. لا يدخل نص التعاون الخام إلى الملف، ولا تتحول العادات المرصودة إلى سياسة.",
    releaseMetricsAria: "ما يبقى قابلًا للتتبّع في الحمض النووي للمشروع", releaseRevision: "مراجعة دقيقة", releaseDeclaration: "يبقى الملف مرتبطًا بالشيفرة التي يصفها", releaseConfidence: "الثقة + الحداثة", releaseFile: "تبيّن كل سمة مدى قوة وحداثة دليلها", releaseEvidence: "أدلة مختومة", releaseInspection: "يستطيع الوكيل إظهار أساس كل ملاحظة",
    releaseCaveat: "يمكن للحمض النووي للمشروع توجيه الاستكشاف والمصطلحات والمراجعة. ولا يمكنه إنشاء قرار أو قيد أو سياسة أو إذن أو تجاوز أي منها. <a href=\"/docs\">اقرأ كيف يعمل حد الأدلة ←</a>",
    storyEyebrow: "مشكلة الغريب اللامع", storyTitle: "يفهم بناء الجملة. لكنه لا يفهم لماذا يقول فريقك لا.", storyIntro: "تبقى الشيفرة. وتتلاشى الحكمة التي اكتسبها الفريق بشق الأنفس.",
    monday: "يوم الاثنين", monthsLater: "بعد أشهر", nextSession: "الجلسة التالية", withHunch: "مع Hunch",
    story1Title: "يعالج الفريق خطأً مؤلمًا في تسجيل الخروج.", story1Body: "ينقل الفريق الجلسات إلى الخادم كي يتمكّن من إبطال الرمز المسرّب فورًا. يضيف القرار بعض التعقيد، لكنه يغلق الثغرة.",
    story2Title: "تبقى الشيفرة. ويتلاشى السياق.", story2Body: "تُدفن الحادثة في pull request قديم، وينتقل شخصان إلى فريقين آخرين. ويبدو مسار الجلسة غير المعتاد الآن كأنه تعقيد بلا داعٍ.",
    story3Title: "يقترح غريب لامع «تبسيطها».", story3Body: "التغيير مرتب وصحيح محليًا، لكنه يعيد فتح العطل نفسه الذي دفع الفريق ثمن فهمه.",
    story4Title: "يعلّم المستودع الوكيل قبل التعديل.", story4Body: "يعيد Hunch إلى الواجهة ما اختير وما رُفض والخطأ الذي يمنعه القرار. يعمل الوكيل بحكمة الفريق من دون أن يتظاهر بأنه الفريق.",
    receiptAria: "مثال على بطاقة ذاكرة المشروع", beforeEditing: "قبل تعديل", memoryFound: "وُجدت ذاكرة", whyExists: "لماذا توجد هذه الشيفرة",
    logoutTitle: "يجب أن يلغي تسجيل الخروج الوصول فورًا.", chosen: "المختار", chosenBody: "الاحتفاظ بالجلسات على الخادم، وجعل الرموز تحمل معرّفًا مبهمًا فقط.",
    rejected: "المرفوض", rejectedBody: "جلسات تعتمد على JWT فقط؛ تبقى صالحة بعد تسجيل الخروج حتى انتهاء الرمز.",
    protects: "يحمي من", protectsBody: "استخدام رمز مسرّب بعد أن يعيد المستخدم ضبط جلسته.", receiptFoot: "إرشادي · حديث عند هذه المراجعة · الأدلة مرفقة",
    changesEyebrow: "كيف يعمل الحمض النووي للمشروع", changesTitle: "يتعلم Hunch كيف يعمل هذا المستودع، ثم يمنح كل وكيل ما يهمه فقط.", changesIntro: "يحوّل الأدلة الموجودة أصلًا في المستودع إلى سياق محدود وملائم. تبقى العادات المرصودة إرشادًا؛ ولا تكتسب سلطة الإنفاذ إلا القواعد التي يثق بها البشر صراحة.",
    rememberLabel: "01 / راقب", rememberTitle: "اقرأ إشارات المستودع نفسه.", rememberBody: "يدرس Hunch مراجعة Git دقيقة وتاريخًا محدودًا وأعرافًا ملتزمًا بها وأدلة مراجعة يُسمح لأدواتك بتقديمها.",
    recallLabel: "02 / افهم", recallTitle: "ابنِ صورة قابلة للتتبّع.", recallBody: "تحتفظ اللغة وعادات المساهمة وتوقعات المراجعة والأعراف الهندسية بدرجة ثقتها وحداثتها وأدلتها.",
    protectLabel: "03 / علّم", protectTitle: "قدّم الحمض النووي المناسب للعمل.", protectBody: "يحصل الوكيل على السياق الملائم قبل التعديل. لا يتحول السلوك الشائع إلى قاعدة بصمت، وتبقى السلطة بشرية.",
    underEyebrow: "ما يجعله جديرًا بالثقة", underTitle: "ليس شخصية. وليس سياسة خفية. بل أدلة يمكنك فحصها.", underIntro: "يفصل Hunch بين الحمض النووي المرصود للمشروع والذاكرة الهندسية الدائمة والقواعد التي اعتمدها البشر. وتوضح كل إجابة مصدرها وحداثتها والسلطة التي تملكها فعلًا.",
    savedWithGit: "الحمض النووي للمشروع", codeGraph: "ذاكرة هندسية", mcpRules: "رسم الشيفرة", conformance: "سلطة بشرية", provenance: "الأدلة مرفقة", localFirst: "محلي أولًا",
    gitMemoryTitle: "يتعلم كيف يتحدث المستودع", gitMemoryBody: "تأتي المفردات وعادات المساهمة وتوقعات المراجعة والأعراف الهندسية من أدلة المستودع، لا من شخصية مولّدة.",
    blastTitle: "يتذكر لماذا توجد الشيفرة", blastBody: "تبقى القرارات والبدائل المرفوضة والتصحيحات والأخطاء التي أُصلحت متاحة بعد زوال المحادثة أو pull request أو زميل الفريق.",
    assistantsTitle: "يعرف ما قد يتأثر بالتغيير", assistantsBody: "يتتبع Hunch الروابط بين الملفات والدوال ليظهر السبب المناسب في المكان المناسب.",
    checksTitle: "لا يحوّل الشيوع إلى سياسة", checksBody: "تبقى الأنماط المرصودة إرشادية. ولا تكتسب سلطة الإنفاذ إلا قاعدة دقيقة يختار البشر الوثوق بها.",
    receiptsTitle: "يعرض مصدر كل ادعاء", receiptsBody: "تنتقل درجة الثقة والحداثة والمصدر والمراجعة الداعمة مع السياق الذي يتلقاه الوكيل.",
    yoursTitle: "تبقى ذاكرتكم ملككم", yoursBody: "لا يتطلب Hunch حسابًا مستضافًا. احتفظوا بالذاكرة في المشروع أو في مستودع Git خاص يتحكم به الفريق.",
    shortVersion: "هل تريد التفاصيل التقنية؟", explore: "اقرأ كيف يعمل Hunch ←",
    startEyebrow: "ابدأ", startTitle: "دع مستودعك يعرّف بنفسه.",
    installTitle: "ثبّت Hunch", installBody: "يقرأ أمر واحد مشروعك ويربط مساعدي البرمجة الذين تستخدمهم بالفعل.",
    historyTitle: "أضف التاريخ الذي يشرح السبب", historyBody: "يجد <code>hunch backfill --since 90d</code> قرارات ودروسًا مفيدة في commits آخر 90 يومًا.",
    askTitle: "شاهد ما تعلّمه Hunch", askBody: "افحص الحمض النووي لمشروعك، ثم اسأل: <em>«لماذا بُنيت وحدة الجلسات بهذه الطريقة؟»</em> تأتي كل إجابة مع دليل.",
    supportedAria: "المساعدون المدعومون", installComment: "# التثبيت من npm — يتطلب Node 22.13+", initComment: "# ربط Hunch بالمشروع والمساعدين", backfillComment: "# تعلّم اختياري من آخر 90 يومًا", dnaComment: "# افحص الحمض النووي القائم على أدلة المستودع", whyComment: "# اسأل عن سبب وجود ملف",
    copy: "نسخ", copied: "تم النسخ", advisoryNote: "الحمض النووي للمشروع والذاكرة إرشاديان افتراضيًا. لا يُحظر شيء حتى تختار ذلك صراحة.", pluginPrompt: "تستخدم Claude Code؟ ثبّته كإضافة بدلًا من ذلك:",
    ctaTitle: "علّم كل وكيل برمجي كيف يعمل مستودعك.", ctaBody: "امنحه اللغة والقرارات والدروس الصعبة والحدود الكامنة خلف الشيفرة قبل أن يغيّرها، واجعل كل ادعاء قابلًا للتتبّع.",
    about: "يحفظ Git الشيفرة. ويمنح Hunch وكلاء البرمجة الحمض النووي القائم على الأدلة الذي يشرح كيف يعمل المستودع ولماذا بُنيت الشيفرة بهذه الطريقة.",
    product: "المنتج", develop: "التطوير", connect: "روابط", mcpTools: "أدوات MCP", vscodeExtension: "إضافة VS Code",
    canvasDecision: "قرار", canvasBug: "خطأ", canvasRule: "قاعدة", canvasWhy: "لماذا", canvasReason: "استُعيد السبب قبل التعديل", held: "محفوظ", blocked: "محظور",
  },
  es: {
    dir: "ltr", ogLocale: "es_ES",
    title: "Hunch Memory — ADN del proyecto para agentes de programación con IA",
    description: "Tu repositorio tiene ADN. Hunch ofrece a los agentes de programación una comprensión basada en evidencia de cómo se comunica y trabaja el proyecto antes de que cambien el código.",
    ogDescription: "Cada agente de programación llega como un extraño brillante. Hunch le enseña el lenguaje, las decisiones, las correcciones difíciles y los límites que hay detrás de tu código.",
    mainNav: "Navegación principal", language: "Idioma",
    thesisTag: "Estado determinista", thesisText: "Los agentes son probabilísticos. Las organizaciones necesitan estado determinista.", thesisCta: "Leer la tesis →",
    navHow: "Cómo funciona", navInside: "Cómo está hecho", docs: "Documentación", blog: "Blog", changelog: "Cambios",
    getStarted: "Empezar", seeHow: "Ver cómo funciona", readDocs: "Leer la documentación", benchmark: "Benchmark",
    releaseEyebrow: "ADN del proyecto para agentes de programación con IA", heroTitle: "Tu repositorio tiene ADN.<br /><b>Hunch se lo enseña a cada agente de programación.</b>",
    heroLede: "Cada agente de programación llega dominando la sintaxis y sin conocer a tu equipo. Hunch le da el lenguaje, las decisiones, las correcciones difíciles y los límites que hay detrás del código antes de que lo cambie.",
    heroNote: "No es una personalidad. No es otro prompt. Es una comprensión trazable de cómo funciona de verdad tu repositorio, con confianza, vigencia y evidencia adjuntas.",
    releaseProofEyebrow: "ADN del proyecto en v1.22", releaseProofTitle: "Comprensión basada en evidencia, no en sensaciones.",
    releaseProofBody: "Hunch construye un perfil ligado a una revisión concreta a partir del historial de Git, archivos de convenciones y evidencia acotada de revisiones. El texto bruto de la colaboración no entra en el perfil y los hábitos observados nunca se convierten en política.",
    releaseMetricsAria: "Lo que el ADN del proyecto mantiene trazable", releaseRevision: "revisión exacta", releaseDeclaration: "el perfil queda ligado al código que describe", releaseConfidence: "confianza + vigencia", releaseFile: "cada rasgo indica con qué fuerza y actualidad está respaldado", releaseEvidence: "evidencia sellada", releaseInspection: "el agente puede mostrar la base de cada observación",
    releaseCaveat: "El ADN del proyecto puede orientar la exploración, la terminología y la revisión. No puede crear ni anular una decisión, restricción, política o permiso. <a href=\"/docs\">Lee cómo funciona el límite de evidencia →</a>",
    storyEyebrow: "el problema del extraño brillante", storyTitle: "Entiende la sintaxis. No entiende por qué tu equipo dice que no.", storyIntro: "El código permanece. El criterio ganado con esfuerzo se desvanece.",
    monday: "Lunes", monthsLater: "Meses después", nextSession: "Siguiente sesión", withHunch: "Con Hunch",
    story1Title: "Un equipo resuelve un doloroso error de cierre de sesión.", story1Body: "Mueven las sesiones al servidor para poder revocar de inmediato un token filtrado. La decisión añade complejidad, pero cierra la brecha.",
    story2Title: "El código permanece. El contexto se desvanece.", story2Body: "El incidente queda enterrado en un pull request antiguo. Dos personas cambian de equipo. El flujo inusual de la sesión ahora parece maquinaria innecesaria.",
    story3Title: "Un extraño brillante propone «simplificarlo».", story3Body: "El cambio es limpio y correcto de forma local. También reabre el mismo fallo que el equipo ya pagó por comprender.",
    story4Title: "El repositorio enseña al agente antes de editar.", story4Body: "Hunch recupera qué se eligió, qué se descartó y qué error evita la decisión. El agente trabaja con el criterio del equipo sin fingir que es el equipo.",
    receiptAria: "Ejemplo de tarjeta de memoria del proyecto", beforeEditing: "antes de editar", memoryFound: "memoria encontrada", whyExists: "Por qué existe este código",
    logoutTitle: "Cerrar sesión debe revocar el acceso de inmediato.", chosen: "elegido", chosenBody: "Mantener las sesiones en el servidor y dejar que los tokens solo lleven un identificador opaco.",
    rejected: "descartado", rejectedBody: "Sesiones basadas solo en JWT; siguen siendo válidas tras cerrar sesión hasta que caducan.",
    protects: "protege de", protectsBody: "Usar un token filtrado después de que la persona restablezca su sesión.", receiptFoot: "orientativo · vigente en esta revisión · evidencia adjunta",
    changesEyebrow: "cómo funciona el ADN del proyecto", changesTitle: "Hunch aprende cómo funciona este repositorio y después da a cada agente solo lo que importa.", changesIntro: "Convierte la evidencia que ya existe en el repositorio en contexto acotado y relevante. Los hábitos observados siguen siendo consejos; solo las reglas en las que las personas confían de forma explícita pueden obtener autoridad de aplicación.",
    rememberLabel: "01 / observar", rememberTitle: "Lee las señales del propio repositorio.", rememberBody: "Hunch estudia una revisión exacta de Git, historial acotado, convenciones comprometidas y evidencia de revisiones que tus herramientas están autorizadas a aportar.",
    recallLabel: "02 / comprender", recallTitle: "Construye una imagen trazable.", recallBody: "El lenguaje, los hábitos de contribución, las expectativas de revisión y las convenciones de ingeniería conservan su confianza, vigencia y evidencia.",
    protectLabel: "03 / enseñar", protectTitle: "Lleva el ADN adecuado al trabajo.", protectBody: "El agente recibe el contexto relevante antes de editar. El comportamiento común nunca se convierte en regla a escondidas y la autoridad sigue siendo humana.",
    underEyebrow: "qué lo hace confiable", underTitle: "No es una personalidad. No es una política invisible. Es evidencia que puedes inspeccionar.", underIntro: "Hunch mantiene separados el ADN observado del proyecto, la memoria duradera de ingeniería y las reglas aprobadas por personas. Cada respuesta indica de dónde viene, su vigencia y la autoridad que realmente tiene.",
    savedWithGit: "ADN del proyecto", codeGraph: "memoria de ingeniería", mcpRules: "grafo de código", conformance: "autoridad humana", provenance: "evidencia adjunta", localFirst: "local primero",
    gitMemoryTitle: "Aprende cómo habla el repositorio", gitMemoryBody: "El vocabulario, los hábitos de contribución, las expectativas de revisión y las convenciones de ingeniería provienen de evidencia del repositorio, no de una personalidad generada.",
    blastTitle: "Recuerda por qué existe el código", blastBody: "Las decisiones, los enfoques descartados, las correcciones y los errores resueltos siguen disponibles cuando el chat, el pull request o el compañero ya no están.",
    assistantsTitle: "Sabe qué puede afectar un cambio", assistantsBody: "Hunch sigue las conexiones entre archivos y funciones para mostrar la razón adecuada en el lugar adecuado.",
    checksTitle: "Nunca convierte popularidad en política", checksBody: "Los patrones observados siguen siendo orientativos. Solo una regla precisa en la que las personas decidan confiar puede obtener autoridad de aplicación.",
    receiptsTitle: "Muestra de dónde sale cada afirmación", receiptsBody: "La confianza, la vigencia, la procedencia y la revisión de respaldo viajan con el contexto que recibe el agente.",
    yoursTitle: "Tu memoria sigue siendo tuya", yoursBody: "Hunch no requiere una cuenta alojada. Guarda la memoria en tu proyecto o en un repositorio Git privado que controle el equipo.",
    shortVersion: "¿Quieres los detalles técnicos?", explore: "Lee cómo funciona Hunch →",
    startEyebrow: "primeros pasos", startTitle: "Deja que tu repositorio se presente.",
    installTitle: "Instala Hunch", installBody: "Un solo comando lee tu proyecto y conecta los asistentes de programación que ya usas.",
    historyTitle: "Añade el historial que explica por qué", historyBody: "<code>hunch backfill --since 90d</code> encuentra decisiones y lecciones útiles en los commits de los últimos 90 días.",
    askTitle: "Mira lo que aprendió Hunch", askBody: "Inspecciona el ADN de tu proyecto y después pregunta: <em>«¿Por qué está construido así el módulo de sesiones?»</em> Cada respuesta viene con evidencia.",
    supportedAria: "Asistentes compatibles", installComment: "# instalación desde npm — requiere Node 22.13+", initComment: "# conecta Hunch al proyecto y a tus asistentes", backfillComment: "# aprende opcionalmente de los últimos 90 días", dnaComment: "# inspecciona el ADN del repositorio basado en evidencia", whyComment: "# pregunta para qué sirve un archivo",
    copy: "copiar", copied: "copiado", advisoryNote: "El ADN del proyecto y la memoria son orientativos por defecto. Nada se bloquea hasta que lo actives de forma explícita.", pluginPrompt: "¿Usas Claude Code? Instálalo como plugin:",
    ctaTitle: "Enseña a cada agente cómo funciona tu repositorio.", ctaBody: "Dale el lenguaje, las decisiones, las lecciones difíciles y los límites que hay detrás del código antes de que lo cambie, y mantén cada afirmación trazable.",
    about: "Git guarda el código. Hunch da a los agentes el ADN basado en evidencia que explica cómo funciona tu repositorio y por qué el código está hecho así.",
    product: "producto", develop: "desarrollo", connect: "enlaces", mcpTools: "Herramientas MCP", vscodeExtension: "Extensión de VS Code",
    canvasDecision: "decisión", canvasBug: "error", canvasRule: "regla", canvasWhy: "por qué", canvasReason: "razón recuperada antes de editar", held: "conservado", blocked: "bloqueado",
  },
};

function escAttr(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function fragments(c) {
  return [
    ["<title>Hunch Memory — Help AI understand your code</title>", `<title>${c.title}</title>`],
    ['content="Your code has DNA. Hunch activates the right Strand for each task—lean context, live guidance, and trusted boundaries before AI changes your code."', `content="${escAttr(c.description)}"`],
    ['<meta property="og:title" content="Hunch Memory — Help AI understand your code" />', `<meta property="og:title" content="${escAttr(c.title)}" />`],
    ['content="Hunch activates the right DNA Strand for every task, giving AI the context, tools, and boundaries it needs."', `content="${escAttr(c.ogDescription)}"`],
    ['<span class="thesis-tag">Deterministic State</span>', `<span class="thesis-tag">${c.thesisTag}</span>`],
    ['<span class="thesis-text">Agents are probabilistic. Organizations need deterministic state.</span>', `<span class="thesis-text">${c.thesisText}</span>`],
    ['<b class="thesis-cta">Read the thesis →</b>', `<b class="thesis-cta">${c.thesisCta}</b>`],
    ['<nav class="nav" aria-label="Main">', `<nav class="nav" aria-label="${escAttr(c.mainNav)}">`],
    ['<span class="sr-only">Language</span>', `<span class="sr-only">${c.language}</span>`],
    ['aria-label="Language"', `aria-label="${escAttr(c.language)}"`],
    [">How it works<", `>${c.navHow}<`], [">Under the hood<", `>${c.navInside}<`], [">Docs<", `>${c.docs}<`], [">Blog<", `>${c.blog}<`], [">Changelog<", `>${c.changelog}<`],
    [">Get started<", `>${c.getStarted}<`], [">See how it works<", `>${c.seeHow}<`], [">Read the docs<", `>${c.readDocs}<`], [">Benchmark<", `>${c.benchmark}<`],
    ['<h1 class="rise d1">Your code has DNA.<br /><b>Hunch helps AI get it.</b></h1>', `<h1 class="rise d1">${c.heroTitle}</h1>`],
    ['<p class="lede rise d2">Hunch learns how your project works, then activates the right DNA Strand for every task—giving AI the context, tools, and boundaries it needs before changing your code.</p>', `<p class="lede rise d2">${c.heroLede}</p>`],
    ['<span class="eyebrow">lean by design</span>', `<span class="eyebrow">${c.releaseProofEyebrow}</span>`],
    ['<h2 id="release-proof-title">Less context. Better understanding.</h2>', `<h2 id="release-proof-title">${c.releaseProofTitle}</h2>`],
    ['<p class="release-copy">Hunch sends only what the task needs—not the whole project, an old chat, or a giant prompt. Less noise and fewer wasted tokens.</p>', `<p class="release-copy">${c.releaseProofBody}</p>`],
    ['aria-label="How Hunch keeps context lean and trustworthy"', `aria-label="${escAttr(c.releaseMetricsAria)}"`],
    ['<strong>right task</strong>', `<strong>${c.releaseRevision}</strong>`],
    ['<span>each Strand is built for one assignment</span>', `<span>${c.releaseDeclaration}</span>`],
    ['<strong>right version</strong>', `<strong>${c.releaseConfidence}</strong>`],
    ['<span>it stays tied to the code the agent is changing</span>', `<span>${c.releaseFile}</span>`],
    ['<strong>source included</strong>', `<strong>${c.releaseEvidence}</strong>`],
    ['<span>the agent can show where every important detail came from</span>', `<span>${c.releaseInspection}</span>`],
    ['<p class="release-caveat">Small enough to keep the agent focused. Strong enough to keep the work inside the lines. <a href="/docs">See how that works →</a></p>', `<p class="release-caveat">${c.releaseCaveat}</p>`],
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
    ['<h3>The right DNA Strand activates first.</h3>', `<h3>${c.story4Title}</h3>`],
    ['<p>The agent sees why the code exists, what it affects, and where it must stop before it edits.</p>', `<p>${c.story4Body}</p>`],
    ['aria-label="Example active DNA Strand"', `aria-label="${escAttr(c.receiptAria)}"`],
    ['<div class="receipt-head"><span>before editing · <bdi>src/auth/session.ts</bdi></span><b>strand active</b></div>', `<div class="receipt-head"><span>${c.beforeEditing} · <bdi>src/auth/session.ts</bdi></span><b>${c.memoryFound}</b></div>`],
    ['<span class="receipt-kicker">Why this code exists</span>', `<span class="receipt-kicker">${c.whyExists}</span>`],
    ['<h3>Logging out must end access right away.</h3>', `<h3>${c.logoutTitle}</h3>`],
    ['<div class="receipt-row"><span>chosen</span><p>Keep sign-ins on the server, where they can be ended at once.</p></div>', `<div class="receipt-row"><span>${c.chosen}</span><p>${c.chosenBody}</p></div>`],
    ['<div class="receipt-row"><span>rejected</span><p>Trust a login token until its timer runs out.</p></div>', `<div class="receipt-row"><span>${c.rejected}</span><p>${c.rejectedBody}</p></div>`],
    ['<div class="receipt-row"><span>protects</span><p>A stolen token being used after logout.</p></div>', `<div class="receipt-row"><span>${c.protects}</span><p>${c.protectsBody}</p></div>`],
    ['<p class="receipt-foot">active Strand · current code · source included</p>', `<p class="receipt-foot">${c.receiptFoot}</p>`],
    ['<span class="eyebrow">how hunch works</span>', `<span class="eyebrow">${c.changesEyebrow}</span>`],
    ['<h2>Every task activates the right DNA Strand.</h2>', `<h2>${c.changesTitle}</h2>`],
    ['<p>A small, focused slice of Project DNA guides one assignment from start to finish.</p>', `<p>${c.changesIntro}</p>`],
    ['<span class="step-n">01 / learn</span>', `<span class="step-n">${c.rememberLabel}</span>`], ['<h3>Learn the Project DNA.</h3>', `<h3>${c.rememberTitle}</h3>`],
    ['<p>Hunch learns how the code connects, why choices were made, what failed, and what the team expects.</p>', `<p>${c.rememberBody}</p>`],
    ['<span class="step-n">02 / activate</span>', `<span class="step-n">${c.recallLabel}</span>`], ['<h3>Activate only what matters.</h3>', `<h3>${c.recallTitle}</h3>`],
    ['<p>It selects the knowledge, working area, risks, and boundaries for this task.</p>', `<p>${c.recallBody}</p>`],
    ['<span class="step-n">03 / guide</span>', `<span class="step-n">${c.protectLabel}</span>`], ['<h3>Guide the whole job.</h3>', `<h3>${c.protectTitle}</h3>`],
    ['<p>The Strand gives the agent the right tools before, during, and after the change.</p>', `<p>${c.protectBody}</p>`],
    ['<span class="eyebrow">more than context</span>', `<span class="eyebrow">${c.underEyebrow}</span>`], ['<h2>A set of tools guides the agent.</h2>', `<h2>${c.underTitle}</h2>`],
    ['<p>The active Strand helps the agent understand, plan, stay in scope, and check its work.</p>', `<p>${c.underIntro}</p>`],
    ['<code class="literal">why</code>', `<code class="literal">${c.savedWithGit}</code>`], ['<code>blast radius</code>', `<code>${c.codeGraph}</code>`], ['<code>scope</code>', `<code>${c.mcpRules}</code>`], ['<code>compare</code>', `<code>${c.conformance}</code>`], ['<code>conform</code>', `<code>${c.provenance}</code>`], ['<code>change gate</code>', `<code>${c.localFirst}</code>`],
    ['<h3>Understands why</h3>', `<h3>${c.gitMemoryTitle}</h3>`], ['<p>Shows the decisions, rejected ideas, and past failures behind the code.</p>', `<p>${c.gitMemoryBody}</p>`],
    ['<h3>Sees the ripple effect</h3>', `<h3>${c.blastTitle}</h3>`], ['<p>Shows which files, features, and systems a change could affect.</p>', `<p>${c.blastBody}</p>`],
    ['<h3>Keeps the work focused</h3>', `<h3>${c.assistantsTitle}</h3>`], ['<p>Gives the agent a clear working area and keeps unrelated changes out.</p>', `<p>${c.assistantsBody}</p>`],
    ['<h3>Compares safer paths</h3>', `<h3>${c.checksTitle}</h3>`], ['<p>Checks different approaches against what the project already knows.</p>', `<p>${c.checksBody}</p>`],
    ['<h3>Checks that it fits</h3>', `<h3>${c.receiptsTitle}</h3>`], ['<p>Makes sure the change still follows the project’s structure and architecture.</p>', `<p>${c.receiptsBody}</p>`],
    ['<h3>Protects trusted boundaries</h3>', `<h3>${c.yoursTitle}</h3>`], ['<p>Catches conflicts with rules your team chose to protect, with the source attached.</p>', `<p>${c.yoursBody}</p>`],
    ['<p class="tech-link">Want the technical details? <a href="/docs">Read how Hunch works →</a></p>', `<p class="tech-link">${c.shortVersion} <a href="/docs">${c.explore}</a></p>`],
    ['<span class="eyebrow">get started</span>', `<span class="eyebrow">${c.startEyebrow}</span>`], ['<h2>Install once. Work normally.</h2>', `<h2>${c.startTitle}</h2>`],
    ['<h3>Install Hunch</h3>', `<h3>${c.installTitle}</h3>`], ['<p>One command connects Hunch to your project and coding tools.</p>', `<p>${c.installBody}</p>`],
    ['<h3>Learn the Project DNA</h3>', `<h3>${c.historyTitle}</h3>`], ['<p>Hunch reads how your project works and connects that knowledge to the code.</p>', `<p>${c.historyBody}</p>`],
    ['<h3>Keep assigning tasks</h3>', `<h3>${c.askTitle}</h3>`], ['<p>Hunch activates a fresh DNA Strand whenever an agent needs one.</p>', `<p>${c.askBody}</p>`],
    ['aria-label="Supported assistants"', `aria-label="${escAttr(c.supportedAria)}"`],
    ['<span class="c-key"># install from npm — Node 22.13+</span>', `<span class="c-key">${c.installComment}</span>`], ['<span class="c-key"># connect Hunch to this project</span>', `<span class="c-key">${c.initComment}</span>`],
    ['<span class="c-key"># learn from the last 90 days</span>', `<span class="c-key">${c.backfillComment}</span>`], ["<span class=\"c-key\"># see your project's DNA</span>", `<span class="c-key">${c.dnaComment}</span>`], ['<span class="c-key"># ask what a file is for</span>', `<span class="c-key">${c.whyComment}</span>`],
    ['<button class="copybtn" data-copy="#install-cmd">copy</button>', `<button class="copybtn" data-copy="#install-cmd">${c.copy}</button>`],
    ['Hunch gives advice by default. It will not block a change unless your team turns that on.<br /><br />', `${c.advisoryNote}<br /><br />`],
    ['Claude Code? Install as a plugin instead:<br />', `${c.pluginPrompt}<br />`],
    ['<h2>One project. One DNA. The right Strand for every task.</h2>', `<h2>${c.ctaTitle}</h2>`], ['<p>Less noise, better decisions, safer changes.</p>', `<p>${c.ctaBody}</p>`],
    ['<p class="about">Git stores your code. Hunch activates the right DNA Strand for every AI task.</p>', `<p class="about">${c.about}</p>`],
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
  html = replaceRequired(html, isPost ? "<title>The Hunch Memory Blog</title>" : "<title>The Hunch Memory Blog — Architectural Conformance for AI code</title>", `<title>${ui.pageTitle}</title>`, `${locale}/${page}`);
  html = replaceRequired(html,
    isPost ? '<meta name="description" content="Architectural Conformance for AI code — notes, benchmarks and arguments." />' : '<meta name="description" content="Notes, benchmarks and arguments on keeping AI-generated code inside your architecture — the semantic invariants pattern-SAST can\'t express." />',
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
    html = replaceRequired(html, '<span>© Hunch — Architectural Conformance for AI code.</span>', `<span>${ui.footerTag}</span>`, `${locale}/${page}`);
    html = replaceRequired(html, '<span><a href="/blog">← All posts</a>', `<span><a href="${blogBase}">${ui.allPostsFooter}</a>`, `${locale}/${page}`);
  } else {
    html = replaceRequired(html, '<span class="eyebrow"><span>●</span> The Hunch Blog</span>', `<span class="eyebrow"><span>●</span> ${ui.eyebrow}</span>`, `${locale}/${page}`);
    html = replaceRequired(html, '<h1>Keeping AI inside your architecture.</h1>', `<h1>${ui.mastheadTitle}</h1>`, `${locale}/${page}`);
    html = replaceRequired(html, '<p>Benchmarks, arguments and field notes on the one class of mistake AI ships that your linter can\'t see — and the deterministic gate that catches it.</p>', `<p>${ui.mastheadIntro}</p>`, `${locale}/${page}`);
    html = replaceRequired(html, '<div class="kicker">Pinned</div>', `<div class="kicker">${ui.pinned}</div>`, `${locale}/${page}`);
    html = replaceRequired(html, '<div class="kicker">All posts</div>', `<div class="kicker">${ui.allPosts}</div>`, `${locale}/${page}`);
    html = replaceRequired(html, '<span>© Hunch — Architectural Conformance for AI code · git-native, MCP-native.</span>', `<span>${ui.footerTag} · git-native, MCP-native.</span>`, `${locale}/${page}`);
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
  for (const phrase of ["Keeping AI inside", "All posts", "Get started", "How it works"]) {
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
  html = replaceRequired(html, "<title>Changelog — Hunch Memory</title>", `<title>${ui.pageTitle}</title>`, `${locale}/changelog`);
  html = replaceRequired(html, '<meta name="description" content="Every Hunch release — git-native engineering memory and Architectural Conformance for AI code." />', `<meta name="description" content="${escAttr(ui.pageDescription)}" />`, `${locale}/changelog`);
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
  html = replaceRequired(html, '<p>From a git-native decision graph to deterministic Architectural Conformance — the whole arc, newest first.</p>', `<p>${ui.intro}</p>`, `${locale}/changelog`);
  html = replaceRequired(html, '<span>© Hunch — Architectural Conformance for AI code.</span>', `<span>${ui.footer}</span>`, `${locale}/changelog`);
  html = replaceRequired(html, '<span><a href="/">Home</a> · <a href="/docs">Docs</a> · <a href="/blog">Blog</a> · <a href="https://github.com/davesheffer/hunch/releases" target="_blank" rel="noopener">GitHub releases</a></span>', `<span><a href="/${locale}">${ui.home}</a> · <a href="/docs">${ui.docs}</a> · <a href="/${locale}/blog">${ui.blog}</a> · <a href="https://github.com/davesheffer/hunch/releases" target="_blank" rel="noopener">${ui.githubReleases}</a></span>`, `${locale}/changelog`);

  let titleIndex = 0;
  html = html.replace(changelogRowPattern, (_row, version) => `<div class="clog-row"><span class="rel-tag">${version}</span><span class="clog-t"><b>${escapeVisible(copy.titles[titleIndex++])}</b></span></div>`);
  if (titleIndex !== changelogRowCount) throw new Error(`[${locale}/changelog] replaced ${titleIndex}/${changelogRowCount} release rows`);
  html = html.replace(/<div class="clog-date">([^<]+)<\/div>/g, (_match, date) => `<div class="clog-date">${localizeChangelogDate(date, copy.dateLocale)}</div>`);
  html = html.replace("<!doctype html>", `<!doctype html>\n<!-- Generated by tooling/generate-site-locales.mjs. Edit site/changelog.html or tooling/changelog-locales.mjs, then regenerate. -->`);
  const visibleHtml = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const phrase of ["Every release", "From a git-native", "How it works", "Get started", "Initial release"]) {
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
