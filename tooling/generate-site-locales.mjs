import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blogLocales } from "./blog-locales.mjs";
import { changelogLocales, countChangelogRows } from "./changelog-locales.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "site", "index.html");
const siteOrigin = "https://hunch-pi.vercel.app";
const normalizeLf = (value) => value.replace(/\r\n?/g, "\n");

const locales = {
  he: {
    dir: "rtl",
    ogLocale: "he_IL",
    title: "Hunch — זיכרון לפרויקט עבור עוזרי קוד מבוססי AI",
    description: "Hunch מסביר לעוזרי קוד מבוססי AI למה הקוד בנוי כך, אילו באגים כבר תוקנו ואילו החלטות לא כדאי לקבל שוב.",
    ogDescription: "ה-AI יודע לקרוא את הקוד. Hunch נותן לו את ההחלטות, תיקוני הבאגים והאזהרות שמאחוריו לפני השינוי.",
    mainNav: "ניווט ראשי", language: "שפה",
    navHow: "כך זה עובד", navInside: "מאחורי הקלעים", docs: "תיעוד", blog: "בלוג", changelog: "יומן שינויים",
    getStarted: "מתחילים", seeHow: "כך זה עובד", readDocs: "קריאת התיעוד", benchmark: "מדד ביצועים",
    releaseEyebrow: "זיכרון לפרויקט עבור עוזרי קוד מבוססי AI", heroTitle: "ה-AI שלכם יודע לקרוא את הקוד.<br /><b>Hunch מסביר למה הוא בנוי כך.</b>",
    heroLede: "Hunch נותן ל-Claude, ל-Cursor, ל-Codex ולעוזרי קוד אחרים את ההחלטות, תיקוני הבאגים והאזהרות שהצוות למד — לפני שהם משנים את הקוד.",
    heroNote: "Hunch עובד עם כלי ה-AI שכבר יש לכם. הוא אינו מודל נוסף, ואינו שולח את זיכרון הפרויקט לשירות של Hunch.",
    releaseProofEyebrow: "מה השתפר ב-v1.19", releaseProofTitle: "מצאו את הקוד הסביר מהר יותר. בדקו פחות.",
    releaseProofBody: "במבחן של 12 בעיות על קוד לא מוכר, Hunch מצא את קטע הקוד שהשתנה ב-6 מקרים במקום ב-3. במבחן נפרד הוא שמר על אותם חמישה ממצאים מוצלחים, עם 41.9% פחות קוד לבדיקה.",
    releaseMetricsAria: "תוצאות מבחן גרסה 1.19 בשפה פשוטה", releaseDeclaration: "בעיות שבהן נמצא הקוד שהשתנה", releaseFile: "בעיות שבהן נמצא הקובץ הנכון", releaseInspection: "קטעי קוד לבדיקה בממוצע",
    releaseCaveat: "אלה מבחנים קטנים ומבוקרים — לא הבטחה ש-Hunch מדויק פי שניים בכל מקום. כשהוא יודע רק איפה לחקור, Hunch אומר זאת במקום להעמיד פנים שהוא יודע את התיקון המדויק.",
    storyEyebrow: "סיפור מוכר", storyTitle: "הבאג תוקן. הסיבה נשכחה.", storyIntro: "מנגנון הגנה לא מובן מאליו נשאר בקוד. הסיפור שמאחוריו הולך ונעלם.",
    monday: "יום שני", monthsLater: "כעבור חודשים", nextSession: "בסשן הבא", withHunch: "עם Hunch",
    story1Title: "הצוות פותר באג התנתקות כואב.", story1Body: "הם מעבירים את הסשנים לשרת כדי שאפשר יהיה לבטל מיד טוקן שדלף. הבחירה מוסיפה מורכבות, אבל סוגרת את הפרצה.",
    story2Title: "הקוד נשאר. ההקשר דוהה.", story2Body: "האירוע קבור ב-pull request ישן. שני אנשים עברו לצוותים אחרים. זרימת הסשן החריגה נראית עכשיו כמו מנגנון מיותר.",
    story3Title: "עוזר AI מציע „לפשט” אותו.", story3Body: "השינוי נקי ונכון מקומית. הוא גם פותח מחדש בדיוק את הכשל שהצוות כבר שילם כדי להבין.",
    story4Title: "הסיבה מגיעה לפני העריכה.", story4Body: "העוזר רואה מה נבחר, מה נדחה ואיזה באג הבחירה מונעת. הוא בוחר דרך טובה יותר בלי לבקש מהצוות לספר שוב את הסיפור.",
    receiptAria: "דוגמה לכרטיס זיכרון של הפרויקט", beforeEditing: "לפני עריכת", memoryFound: "נמצא זיכרון", whyExists: "למה הקוד הזה קיים",
    logoutTitle: "התנתקות חייבת לבטל גישה מיד.", chosen: "נבחר", chosenBody: "לשמור סשנים בצד השרת ולאפשר לטוקנים לשאת רק מזהה אטום.",
    rejected: "נדחה", rejectedBody: "סשנים המבוססים רק על JWT; הם נשארים תקפים אחרי התנתקות עד שפג תוקפם.",
    protects: "מגן מפני", protectsBody: "שימוש בטוקן שדלף אחרי שהמשתמש איפס את הסשן שלו.", receiptFoot: "ייעוץ בלבד · ההחלטה והבאג מצורפים כראיות",
    changesEyebrow: "מה Hunch עושה", changesTitle: "הוא נותן לכל עוזר קוד את אותו זיכרון של הפרויקט.", changesIntro: "Hunch שומר את מה שהצוות למד, מחזיר אותו לפני עריכה ומזהיר כששינוי עלול לחזור על טעות ישנה.",
    rememberLabel: "01 / לשמור", rememberTitle: "שמרו את מה שהצוות למד.", rememberBody: "החלטות, כשלי בדיקות והתיקונים שלכם הופכים לזיכרון הפרויקט במקום להיעלם בצ'אטים וב-pull requests ישנים.",
    recallLabel: "02 / להזכיר", recallTitle: "הסבירו לפני שינוי הקוד.", recallBody: "העוזר רואה למה קובץ בנוי כך, מה תלוי בו ומה כבר התקלקל שם בעבר.",
    protectLabel: "03 / להזהיר", protectTitle: "זהו טעויות שחוזרות.", protectBody: "אם שינוי סותר החלטה מהימנה או מחזיר באג מוכר, Hunch מסביר את ההתנגשות. חסימה היא אופציונלית.",
    underEyebrow: "מה קורה מאחורי הקלעים", underTitle: "Hunch נשאר בשליטתכם ומראה איך הגיע לתשובה.", underIntro: "זיכרון הפרויקט נשמר בקבצים קריאים שאפשר לבדוק ולבטל. Hunch מחבר כל סיבה שמורה לקוד שהיא משפיעה עליו ומצרף מקור לכל תשובה.",
    savedWithGit: "נשמר עם Git", codeGraph: "חיבורי קוד", mcpRules: "כלי ה-AI שלכם", conformance: "כללים ברורים", provenance: "המקור מצורף", localFirst: "ללא ענן של Hunch",
    gitMemoryTitle: "זיכרון שאפשר לבדוק", gitMemoryBody: "החלטות נשמרות כקבצים פשוטים. הצוות יכול לבדוק, להשוות ולבטל אותן בדיוק כמו קוד.",
    blastTitle: "יודע על מה שינוי עשוי להשפיע", blastBody: "Hunch עוקב אחרי החיבורים בין קבצים ופונקציות כדי שהסיבה הנכונה תופיע במקום הנכון.",
    assistantsTitle: "זיכרון אחד לכל העוזרים", assistantsBody: "Claude Code, Cursor, VS Code, Windsurf, Codex ואחרים יכולים להשתמש באותו זיכרון פרויקט.",
    checksTitle: "בודק את אותו כלל בכל פעם", checksBody: "עבור כללים שהצוות בוחר לסמוך עליהם, Hunch בודק את הקוד ישירות במקום לבקש מ-AI אחר לנחש.",
    receiptsTitle: "מראה מאיפה התשובה הגיעה", receiptsBody: "כל תשובה מפנה להחלטה, לבאג, לקומיט או לתיקון שתומכים בה.",
    yoursTitle: "הזיכרון נשאר שלכם", yoursBody: "Hunch לא דורש חשבון מתארח. שמרו את הזיכרון בפרויקט או במאגר Git פרטי שבשליטת הצוות.",
    shortVersion: "רוצים את הפרטים הטכניים?", explore: "כך Hunch עובד ←",
    startEyebrow: "מתחילים", startTitle: "תנו לסשן ה-AI הבא שלכם זיכרון.",
    installTitle: "התקינו את Hunch", installBody: "פקודה אחת קוראת את הפרויקט ומחברת את עוזרי הקוד שכבר נמצאים בשימוש.",
    historyTitle: "הוסיפו היסטוריה אחרונה", historyBody: "<code>hunch backfill --since 90d</code> מוצא החלטות ולקחים שימושיים ב-90 הימים האחרונים של הקומיטים.",
    askTitle: "שאלו שאלה אמיתית", askBody: "נסו <em>„למה מודול הסשן בנוי כך?”</em> העוזר עונה מתוך ההיסטוריה של הצוות ומצרף ראיות.",
    supportedAria: "עוזרים נתמכים", installComment: "# התקנה מ-npm — נדרש Node 22.13+", initComment: "# חיבור Hunch לפרויקט ולעוזרים", backfillComment: "# אפשר ללמוד מ-90 הימים האחרונים", whyComment: "# לשאול למה קובץ קיים",
    copy: "העתקה", copied: "הועתק", pluginPrompt: "משתמשים ב-Claude Code? התקינו במקום זאת כתוסף:",
    ctaTitle: "תנו לבסיס הקוד לזכור למה.", ctaBody: "השאירו את ההחלטות שהצוות כבר קיבל זמינות לכל אדם ולכל עוזר שיגיעו בהמשך.",
    about: "Git שומר את הקוד. Hunch שומר את ההחלטות, תיקוני הבאגים והאזהרות שמסבירים למה הקוד בנוי כך.",
    product: "מוצר", develop: "פיתוח", connect: "קישורים", mcpTools: "כלי MCP", vscodeExtension: "תוסף ל-VS Code",
    canvasDecision: "החלטה", canvasBug: "באג", canvasRule: "כלל", canvasWhy: "למה", canvasReason: "הסיבה נשלפה לפני העריכה", held: "נשמר", blocked: "נחסם",
  },
  ru: {
    dir: "ltr", ogLocale: "ru_RU",
    title: "Hunch — память проекта для ИИ-помощников по коду",
    description: "Hunch объясняет ИИ-помощникам, почему код устроен именно так, какие ошибки уже исправили и какие решения не стоит повторять.",
    ogDescription: "ИИ умеет читать код. Hunch показывает ему решения, исправления и предупреждения до того, как он внесёт изменение.",
    mainNav: "Основная навигация", language: "Язык",
    navHow: "Как это работает", navInside: "Что внутри", docs: "Документация", blog: "Блог", changelog: "История изменений",
    getStarted: "Начать", seeHow: "Посмотреть, как это работает", readDocs: "Читать документацию", benchmark: "Бенчмарк",
    releaseEyebrow: "память проекта для ИИ-помощников по коду", heroTitle: "Ваш ИИ умеет читать код.<br /><b>Hunch объясняет, почему код устроен именно так.</b>",
    heroLede: "Hunch передаёт Claude, Cursor, Codex и другим помощникам решения, исправления ошибок и предупреждения вашей команды до того, как они изменят код.",
    heroNote: "Hunch работает с уже знакомыми вам ИИ-инструментами. Это не ещё одна модель, и память проекта не отправляется в сервис Hunch.",
    releaseProofEyebrow: "что улучшилось в v1.19", releaseProofTitle: "Быстрее находите нужный код. Проверяйте меньше.",
    releaseProofBody: "В тесте из 12 задач на незнакомом коде Hunch нашёл изменённый фрагмент в 6 случаях вместо 3. В отдельном тесте он сохранил те же пять успешных находок, но потребовал просмотреть на 41,9% меньше кода.",
    releaseMetricsAria: "Результаты теста версии 1.19 простыми словами", releaseDeclaration: "задач, где найден изменённый код", releaseFile: "задач, где найден правильный файл", releaseInspection: "фрагментов кода для просмотра в среднем",
    releaseCaveat: "Это небольшие контролируемые тесты, а не обещание двойной точности везде. Если Hunch знает только место для поиска, он честно говорит об этом, а не притворяется, что знает точное исправление.",
    storyEyebrow: "знакомая история", storyTitle: "Ошибку исправили. Причину забыли.", storyIntro: "В коде остаётся неочевидная защита. История её появления постепенно исчезает.",
    monday: "Понедельник", monthsLater: "Через несколько месяцев", nextSession: "Следующий сеанс", withHunch: "С Hunch",
    story1Title: "Команда исправляет болезненную ошибку выхода.", story1Body: "Сессии переносят на сервер, чтобы скомпрометированный токен можно было немедленно отозвать. Решение усложняет систему, но закрывает уязвимость.",
    story2Title: "Код остаётся. Контекст стирается.", story2Body: "Инцидент затерялся в старом pull request. Два человека перешли в другие команды. Необычный поток сессии теперь выглядит ненужным усложнением.",
    story3Title: "ИИ-помощник предлагает всё «упростить».", story3Body: "Изменение аккуратно и локально корректно. Но оно снова открывает тот самый дефект, за понимание которого команда уже заплатила.",
    story4Title: "Причина появляется до правки.", story4Body: "Помощник видит, что выбрали, что отвергли и какую ошибку предотвращает решение. Он выбирает лучший путь, не заставляя команду пересказывать историю.",
    receiptAria: "Пример карточки памяти проекта", beforeEditing: "перед изменением", memoryFound: "память найдена", whyExists: "Почему существует этот код",
    logoutTitle: "Выход должен немедленно отзывать доступ.", chosen: "выбрано", chosenBody: "Хранить сессии на сервере, а в токене оставлять только непрозрачный идентификатор.",
    rejected: "отвергнуто", rejectedBody: "Сессии только на JWT: после выхода они действуют до истечения срока токена.",
    protects: "защищает от", protectsBody: "Использования украденного токена после сброса пользовательской сессии.", receiptFoot: "рекомендация · решение и ошибка приложены как доказательства",
    changesEyebrow: "что делает Hunch", changesTitle: "Он даёт каждому помощнику одну и ту же память проекта.", changesIntro: "Hunch сохраняет опыт команды, возвращает его перед правкой и предупреждает, если изменение может повторить старую ошибку.",
    rememberLabel: "01 / сохранить", rememberTitle: "Сохраните опыт команды.", rememberBody: "Решения, падения тестов и ваши исправления становятся памятью проекта, а не исчезают в старых чатах и pull request.",
    recallLabel: "02 / напомнить", recallTitle: "Объясните до изменения кода.", recallBody: "Помощник видит, почему файл устроен так, что от него зависит и что здесь уже ломалось.",
    protectLabel: "03 / предупредить", protectTitle: "Замечайте повторные ошибки.", protectBody: "Если изменение противоречит доверенному решению или возвращает известную ошибку, Hunch объясняет конфликт. Блокировка необязательна.",
    underEyebrow: "что происходит за кулисами", underTitle: "Hunch остаётся под вашим контролем и показывает свою работу.", underIntro: "Память проекта хранится в понятных файлах, которые можно проверить и отменить. Hunch связывает каждую сохранённую причину с нужным кодом и указывает источник ответа.",
    savedWithGit: "хранится в Git", codeGraph: "связи в коде", mcpRules: "ваши ИИ-инструменты", conformance: "ясные правила", provenance: "источник указан", localFirst: "без облака Hunch",
    gitMemoryTitle: "Память, которую можно проверить", gitMemoryBody: "Решения сохраняются как обычные файлы. Команда может просматривать, сравнивать и отменять их так же, как код.",
    blastTitle: "Знает, на что может повлиять изменение", blastBody: "Hunch следует связям между файлами и функциями, чтобы нужная причина появилась в нужном месте.",
    assistantsTitle: "Одна память для всех помощников", assistantsBody: "Claude Code, Cursor, VS Code, Windsurf, Codex и другие могут использовать одну память проекта.",
    checksTitle: "Каждый раз проверяет одно и то же правило", checksBody: "Для правил, которым доверяет команда, Hunch проверяет сам код, а не просит другой ИИ угадать.",
    receiptsTitle: "Показывает источник ответа", receiptsBody: "Каждый ответ ссылается на решение, ошибку, коммит или исправление, которое его подтверждает.",
    yoursTitle: "Ваша память остаётся вашей", yoursBody: "Hunch не требует облачного аккаунта. Храните память в проекте или в приватном Git-репозитории команды.",
    shortVersion: "Нужны технические подробности?", explore: "Как работает Hunch →",
    startEyebrow: "начало работы", startTitle: "Дайте память следующему сеансу с ИИ.",
    installTitle: "Установите Hunch", installBody: "Одна команда читает проект и подключает помощников по коду, которыми вы уже пользуетесь.",
    historyTitle: "Добавьте недавнюю историю", historyBody: "<code>hunch backfill --since 90d</code> находит полезные решения и уроки в коммитах за последние 90 дней.",
    askTitle: "Задайте настоящий вопрос", askBody: "Спросите: <em>«Почему модуль сессий устроен именно так?»</em> Помощник ответит из истории команды и приложит доказательства.",
    supportedAria: "Поддерживаемые помощники", installComment: "# установка из npm — требуется Node 22.13+", initComment: "# подключить Hunch к проекту и помощникам", backfillComment: "# при желании изучить последние 90 дней", whyComment: "# спросить, зачем нужен файл",
    copy: "копировать", copied: "скопировано", pluginPrompt: "Используете Claude Code? Установите плагин:",
    ctaTitle: "Пусть кодовая база помнит почему.", ctaBody: "Сохраните уже принятые решения доступными каждому человеку и каждому помощнику, которые придут после вас.",
    about: "Git хранит код. Hunch хранит решения, исправления и предупреждения, которые объясняют, почему код устроен именно так.",
    product: "продукт", develop: "разработка", connect: "ссылки", mcpTools: "Инструменты MCP", vscodeExtension: "Расширение VS Code",
    canvasDecision: "решение", canvasBug: "ошибка", canvasRule: "правило", canvasWhy: "почему", canvasReason: "причина найдена до правки", held: "сохранено", blocked: "заблокировано",
  },
  ar: {
    dir: "rtl", ogLocale: "ar",
    title: "Hunch — ذاكرة المشروع لمساعدي البرمجة بالذكاء الاصطناعي",
    description: "يشرح Hunch لمساعدي البرمجة لماذا بُنيت الشيفرة بهذه الطريقة، وما الأخطاء التي أُصلحت، وما القرارات التي لا ينبغي تكرارها.",
    ogDescription: "يستطيع الذكاء الاصطناعي قراءة الشيفرة. ويعطيه Hunch القرارات والإصلاحات والتحذيرات قبل أن يجري تغييرًا.",
    mainNav: "التنقّل الرئيسي", language: "اللغة",
    navHow: "كيف يعمل", navInside: "ما وراء الواجهة", docs: "الوثائق", blog: "المدوّنة", changelog: "سجل التغييرات",
    getStarted: "ابدأ الآن", seeHow: "شاهد كيف يعمل", readDocs: "اقرأ الوثائق", benchmark: "اختبار الأداء",
    releaseEyebrow: "ذاكرة المشروع لمساعدي البرمجة بالذكاء الاصطناعي", heroTitle: "يستطيع الذكاء الاصطناعي قراءة الشيفرة.<br /><b>ويشرح Hunch لماذا بُنيت بهذه الطريقة.</b>",
    heroLede: "يعطي Hunch كلًا من Claude وCursor وCodex وغيرهم قرارات فريقك وإصلاحات الأخطاء والتحذيرات قبل أن يغيّروا الشيفرة.",
    heroNote: "يعمل Hunch مع أدوات الذكاء الاصطناعي التي تستخدمها بالفعل. وهو ليس نموذجًا آخر، ولا يرسل ذاكرة مشروعك إلى خدمة Hunch.",
    releaseProofEyebrow: "ما تحسّن في v1.19", releaseProofTitle: "اعثر على الشيفرة المحتملة أسرع. وافحص أقل.",
    releaseProofBody: "في اختبار من 12 مشكلة على شيفرة غير مألوفة، وجد Hunch الجزء المتغير في 6 حالات بدلًا من 3. وفي اختبار منفصل حافظ على النتائج الخمس الناجحة نفسها مع فحص شيفرة أقل بنسبة 41.9٪.",
    releaseMetricsAria: "نتائج اختبار الإصدار 1.19 بلغة بسيطة", releaseDeclaration: "مشكلات عُثر فيها على الشيفرة المتغيرة", releaseFile: "مشكلات عُثر فيها على الملف الصحيح", releaseInspection: "أجزاء شيفرة للفحص في المتوسط",
    releaseCaveat: "هذه اختبارات صغيرة ومضبوطة، وليست وعدًا بأن Hunch أدق بمرتين في كل مكان. عندما يعرف فقط أين ينبغي البحث، يقول ذلك بدلًا من الادعاء بأنه يعرف الإصلاح الدقيق.",
    storyEyebrow: "قصة مألوفة", storyTitle: "أُصلح الخطأ. وضاع السبب.", storyIntro: "تبقى آلية حماية غير بديهية في الشيفرة، بينما تتلاشى قصتها ببطء.",
    monday: "يوم الاثنين", monthsLater: "بعد أشهر", nextSession: "الجلسة التالية", withHunch: "مع Hunch",
    story1Title: "يعالج الفريق خطأً مؤلمًا في تسجيل الخروج.", story1Body: "ينقل الفريق الجلسات إلى الخادم كي يتمكّن من إبطال الرمز المسرّب فورًا. يضيف القرار بعض التعقيد، لكنه يغلق الثغرة.",
    story2Title: "تبقى الشيفرة. ويتلاشى السياق.", story2Body: "تُدفن الحادثة في pull request قديم، وينتقل شخصان إلى فريقين آخرين. ويبدو مسار الجلسة غير المعتاد الآن كأنه تعقيد بلا داعٍ.",
    story3Title: "يقترح مساعد ذكاء اصطناعي «تبسيطها».", story3Body: "التغيير مرتب وصحيح محليًا، لكنه يعيد فتح العطل نفسه الذي دفع الفريق ثمن فهمه.",
    story4Title: "يصل السبب قبل التعديل.", story4Body: "يرى المساعد ما اختير وما رُفض وأي خطأ يمنعه القرار. فيسلك طريقًا أفضل من دون أن يطلب من الفريق رواية القصة من جديد.",
    receiptAria: "مثال على بطاقة ذاكرة المشروع", beforeEditing: "قبل تعديل", memoryFound: "وُجدت ذاكرة", whyExists: "لماذا توجد هذه الشيفرة",
    logoutTitle: "يجب أن يلغي تسجيل الخروج الوصول فورًا.", chosen: "المختار", chosenBody: "الاحتفاظ بالجلسات على الخادم، وجعل الرموز تحمل معرّفًا مبهمًا فقط.",
    rejected: "المرفوض", rejectedBody: "جلسات تعتمد على JWT فقط؛ تبقى صالحة بعد تسجيل الخروج حتى انتهاء الرمز.",
    protects: "يحمي من", protectsBody: "استخدام رمز مسرّب بعد أن يعيد المستخدم ضبط جلسته.", receiptFoot: "إرشادي · القرار والخطأ مرفقان كدليل",
    changesEyebrow: "ماذا يفعل Hunch", changesTitle: "يعطي كل مساعد برمجة ذاكرة المشروع نفسها.", changesIntro: "يحفظ Hunch ما تعلّمه فريقك، ويعيده قبل التعديل، ويحذّر عندما قد يكرر التغيير خطأً قديمًا.",
    rememberLabel: "01 / احفظ", rememberTitle: "احتفظ بما تعلّمه الفريق.", rememberBody: "تصبح القرارات وأعطال الاختبارات وتصحيحاتكم ذاكرة للمشروع بدلًا من أن تضيع في المحادثات وطلبات السحب القديمة.",
    recallLabel: "02 / ذكّر", recallTitle: "اشرح قبل تغيير الشيفرة.", recallBody: "يرى المساعد لماذا بُني الملف بهذه الطريقة، وما الذي يعتمد عليه، وما الذي تعطل هنا من قبل.",
    protectLabel: "03 / حذّر", protectTitle: "التقط الأخطاء المتكررة.", protectBody: "إذا خالف التغيير قرارًا موثوقًا أو أعاد خطأً معروفًا، يشرح Hunch التعارض. والحظر اختياري.",
    underEyebrow: "ما يحدث خلف الكواليس", underTitle: "يبقى Hunch تحت سيطرتك ويعرض كيف وصل إلى إجابته.", underIntro: "تُحفظ ذاكرة المشروع في ملفات واضحة يمكنك مراجعتها والتراجع عنها. يربط Hunch كل سبب محفوظ بالشيفرة التي يؤثر فيها ويذكر مصدر كل إجابة.",
    savedWithGit: "محفوظ مع Git", codeGraph: "روابط الشيفرة", mcpRules: "أدوات الذكاء الاصطناعي", conformance: "قواعد واضحة", provenance: "المصدر مرفق", localFirst: "لا سحابة لـ Hunch",
    gitMemoryTitle: "ذاكرة يمكنك فحصها", gitMemoryBody: "تُحفظ القرارات كملفات عادية. يمكن لفريقك مراجعتها ومقارنتها والتراجع عنها مثل الشيفرة.",
    blastTitle: "يعرف ما قد يتأثر بالتغيير", blastBody: "يتتبع Hunch الروابط بين الملفات والدوال ليظهر السبب المناسب في المكان المناسب.",
    assistantsTitle: "ذاكرة واحدة لكل المساعدين", assistantsBody: "يمكن لـ Claude Code وCursor وVS Code وWindsurf وCodex وغيرهم استخدام ذاكرة المشروع نفسها.",
    checksTitle: "يفحص القاعدة نفسها كل مرة", checksBody: "بالنسبة إلى القواعد التي يثق بها فريقك، يفحص Hunch الشيفرة مباشرة بدلًا من مطالبة ذكاء اصطناعي آخر بالتخمين.",
    receiptsTitle: "يعرض مصدر الإجابة", receiptsBody: "تشير كل إجابة إلى القرار أو الخطأ أو الـ commit أو التصحيح الذي يدعمها.",
    yoursTitle: "تبقى ذاكرتكم ملككم", yoursBody: "لا يتطلب Hunch حسابًا مستضافًا. احتفظوا بالذاكرة في المشروع أو في مستودع Git خاص يتحكم به الفريق.",
    shortVersion: "هل تريد التفاصيل التقنية؟", explore: "اقرأ كيف يعمل Hunch ←",
    startEyebrow: "ابدأ", startTitle: "امنح جلسة الذكاء الاصطناعي التالية ذاكرة.",
    installTitle: "ثبّت Hunch", installBody: "يقرأ أمر واحد مشروعك ويربط مساعدي البرمجة الذين تستخدمهم بالفعل.",
    historyTitle: "أضف التاريخ الحديث", historyBody: "يجد <code>hunch backfill --since 90d</code> قرارات ودروسًا مفيدة في commits آخر 90 يومًا.",
    askTitle: "اطرح سؤالًا حقيقيًا", askBody: "جرّب: <em>«لماذا بُنيت وحدة الجلسات بهذه الطريقة؟»</em> يجيب مساعدك من تاريخ الفريق ويرفق الدليل.",
    supportedAria: "المساعدون المدعومون", installComment: "# التثبيت من npm — يتطلب Node 22.13+", initComment: "# ربط Hunch بالمشروع والمساعدين", backfillComment: "# تعلّم اختياري من آخر 90 يومًا", whyComment: "# اسأل عن سبب وجود ملف",
    copy: "نسخ", copied: "تم النسخ", pluginPrompt: "تستخدم Claude Code؟ ثبّته كإضافة بدلًا من ذلك:",
    ctaTitle: "اجعل قاعدة شيفرتك تتذكّر السبب.", ctaBody: "أبقِ القرارات التي اتخذها فريقك متاحة لكل شخص ولكل مساعد يأتي بعده.",
    about: "يحفظ Git الشيفرة. ويحفظ Hunch القرارات وإصلاحات الأخطاء والتحذيرات التي تشرح سبب بنائها بهذه الطريقة.",
    product: "المنتج", develop: "التطوير", connect: "روابط", mcpTools: "أدوات MCP", vscodeExtension: "إضافة VS Code",
    canvasDecision: "قرار", canvasBug: "خطأ", canvasRule: "قاعدة", canvasWhy: "لماذا", canvasReason: "استُعيد السبب قبل التعديل", held: "محفوظ", blocked: "محظور",
  },
  es: {
    dir: "ltr", ogLocale: "es_ES",
    title: "Hunch — memoria del proyecto para asistentes de programación con IA",
    description: "Hunch explica a los asistentes de IA por qué el código está hecho así, qué errores ya se corrigieron y qué decisiones no conviene repetir.",
    ogDescription: "Tu IA puede leer el código. Hunch le da las decisiones, correcciones y avisos antes de que haga un cambio.",
    mainNav: "Navegación principal", language: "Idioma",
    navHow: "Cómo funciona", navInside: "Cómo está hecho", docs: "Documentación", blog: "Blog", changelog: "Cambios",
    getStarted: "Empezar", seeHow: "Ver cómo funciona", readDocs: "Leer la documentación", benchmark: "Benchmark",
    releaseEyebrow: "memoria del proyecto para asistentes de programación con IA", heroTitle: "Tu IA puede leer el código.<br /><b>Hunch explica por qué está hecho así.</b>",
    heroLede: "Hunch da a Claude, Cursor, Codex y otros asistentes las decisiones, correcciones de errores y avisos que aprendió tu equipo antes de que cambien el código.",
    heroNote: "Funciona con las herramientas de IA que ya usas. No es otro modelo y no envía la memoria de tu proyecto a un servicio de Hunch.",
    releaseProofEyebrow: "qué mejoró en v1.19", releaseProofTitle: "Encuentra antes el código probable. Revisa menos.",
    releaseProofBody: "En una prueba de 12 problemas sobre código desconocido, Hunch encontró la parte modificada en 6 casos en vez de 3. En otra prueba conservó los mismos cinco aciertos y pidió revisar un 41,9% menos de código.",
    releaseMetricsAria: "Resultados en lenguaje sencillo de la versión 1.19", releaseDeclaration: "problemas donde se encontró el código modificado", releaseFile: "problemas donde se encontró el archivo correcto", releaseInspection: "partes de código para revisar de media",
    releaseCaveat: "Son pruebas pequeñas y controladas, no una promesa de que Hunch sea el doble de preciso en todas partes. Si solo sabe dónde investigar, lo dice en vez de fingir que conoce la corrección exacta.",
    storyEyebrow: "una historia conocida", storyTitle: "El error se corrigió. La razón se perdió.", storyIntro: "Una protección poco obvia sobrevive en el código. La historia que la explica desaparece lentamente.",
    monday: "Lunes", monthsLater: "Meses después", nextSession: "Siguiente sesión", withHunch: "Con Hunch",
    story1Title: "Un equipo resuelve un doloroso error de cierre de sesión.", story1Body: "Mueven las sesiones al servidor para poder revocar de inmediato un token filtrado. La decisión añade complejidad, pero cierra la brecha.",
    story2Title: "El código permanece. El contexto se desvanece.", story2Body: "El incidente queda enterrado en un pull request antiguo. Dos personas cambian de equipo. El flujo inusual de la sesión ahora parece maquinaria innecesaria.",
    story3Title: "Un asistente de IA propone «simplificarlo».", story3Body: "El cambio es limpio y correcto de forma local. También reabre el mismo fallo que el equipo ya pagó por comprender.",
    story4Title: "La razón llega antes que la edición.", story4Body: "El asistente ve qué se eligió, qué se descartó y qué error evita la decisión. Toma un camino mejor sin pedir al equipo que vuelva a contar la historia.",
    receiptAria: "Ejemplo de tarjeta de memoria del proyecto", beforeEditing: "antes de editar", memoryFound: "memoria encontrada", whyExists: "Por qué existe este código",
    logoutTitle: "Cerrar sesión debe revocar el acceso de inmediato.", chosen: "elegido", chosenBody: "Mantener las sesiones en el servidor y dejar que los tokens solo lleven un identificador opaco.",
    rejected: "descartado", rejectedBody: "Sesiones basadas solo en JWT; siguen siendo válidas tras cerrar sesión hasta que caducan.",
    protects: "protege de", protectsBody: "Usar un token filtrado después de que la persona restablezca su sesión.", receiptFoot: "orientativo · la decisión y el error se adjuntan como evidencia",
    changesEyebrow: "qué hace Hunch", changesTitle: "Da a cada asistente la misma memoria del proyecto.", changesIntro: "Hunch guarda lo que aprende tu equipo, lo recupera antes de editar y avisa si un cambio puede repetir un error antiguo.",
    rememberLabel: "01 / guardar", rememberTitle: "Conserva lo que aprendió el equipo.", rememberBody: "Las decisiones, los fallos de pruebas y tus correcciones se convierten en memoria del proyecto en vez de perderse en chats y pull requests antiguos.",
    recallLabel: "02 / recordar", recallTitle: "Explica antes de cambiar código.", recallBody: "El asistente ve por qué un archivo está hecho así, qué depende de él y qué se rompió allí antes.",
    protectLabel: "03 / avisar", protectTitle: "Detecta errores repetidos.", protectBody: "Si un cambio contradice una decisión de confianza o reabre un error conocido, Hunch explica el conflicto. El bloqueo es opcional.",
    underEyebrow: "qué ocurre entre bastidores", underTitle: "Hunch queda bajo tu control y muestra su trabajo.", underIntro: "La memoria del proyecto se guarda en archivos legibles que puedes revisar y deshacer. Hunch conecta cada razón guardada con el código que afecta e incluye la fuente de cada respuesta.",
    savedWithGit: "guardado con Git", codeGraph: "conexiones del código", mcpRules: "tus herramientas de IA", conformance: "reglas claras", provenance: "fuente incluida", localFirst: "sin nube de Hunch",
    gitMemoryTitle: "Memoria que puedes inspeccionar", gitMemoryBody: "Las decisiones se guardan como archivos normales. Tu equipo puede revisarlas, compararlas y deshacerlas igual que el código.",
    blastTitle: "Sabe qué puede afectar un cambio", blastBody: "Hunch sigue las conexiones entre archivos y funciones para mostrar la razón adecuada en el lugar adecuado.",
    assistantsTitle: "Una memoria para todos los asistentes", assistantsBody: "Claude Code, Cursor, VS Code, Windsurf, Codex y otros pueden usar la misma memoria del proyecto.",
    checksTitle: "Comprueba la misma regla cada vez", checksBody: "Para las reglas en las que confía tu equipo, Hunch revisa el código directamente en vez de pedir a otra IA que adivine.",
    receiptsTitle: "Muestra de dónde salió la respuesta", receiptsBody: "Cada respuesta enlaza con la decisión, error, commit o corrección que la respalda.",
    yoursTitle: "Tu memoria sigue siendo tuya", yoursBody: "Hunch no requiere una cuenta alojada. Guarda la memoria en tu proyecto o en un repositorio Git privado que controle el equipo.",
    shortVersion: "¿Quieres los detalles técnicos?", explore: "Lee cómo funciona Hunch →",
    startEyebrow: "primeros pasos", startTitle: "Dale memoria a tu próxima sesión de IA.",
    installTitle: "Instala Hunch", installBody: "Un solo comando lee tu proyecto y conecta los asistentes de programación que ya usas.",
    historyTitle: "Añade el historial reciente", historyBody: "<code>hunch backfill --since 90d</code> encuentra decisiones y lecciones útiles en los commits de los últimos 90 días.",
    askTitle: "Haz una pregunta real", askBody: "Prueba: <em>«¿Por qué está construido así el módulo de sesiones?»</em> Tu asistente responde desde la historia del equipo y aporta evidencia.",
    supportedAria: "Asistentes compatibles", installComment: "# instalación desde npm — requiere Node 22.13+", initComment: "# conecta Hunch al proyecto y a tus asistentes", backfillComment: "# aprende opcionalmente de los últimos 90 días", whyComment: "# pregunta para qué sirve un archivo",
    copy: "copiar", copied: "copiado", pluginPrompt: "¿Usas Claude Code? Instálalo como plugin:",
    ctaTitle: "Haz que tu código recuerde por qué.", ctaBody: "Mantén las decisiones que tu equipo ya tomó disponibles para cada persona y cada asistente que llegue después.",
    about: "Git guarda el código. Hunch guarda las decisiones, correcciones y avisos que explican por qué el código está hecho así.",
    product: "producto", develop: "desarrollo", connect: "enlaces", mcpTools: "Herramientas MCP", vscodeExtension: "Extensión de VS Code",
    canvasDecision: "decisión", canvasBug: "error", canvasRule: "regla", canvasWhy: "por qué", canvasReason: "razón recuperada antes de editar", held: "conservado", blocked: "bloqueado",
  },
};

function escAttr(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function fragments(c) {
  return [
    ["<title>Hunch — project memory for AI coding assistants</title>", `<title>${c.title}</title>`],
    ['content="Hunch tells AI coding assistants why your code is built this way, which bugs were already fixed, and which decisions should not be repeated."', `content="${escAttr(c.description)}"`],
    ['<meta property="og:title" content="Hunch — project memory for AI coding assistants" />', `<meta property="og:title" content="${escAttr(c.title)}" />`],
    ['content="Your AI can read the code. Hunch gives it the decisions, bug fixes, and warnings behind the code before it makes a change."', `content="${escAttr(c.ogDescription)}"`],
    ['<nav class="nav" aria-label="Main">', `<nav class="nav" aria-label="${escAttr(c.mainNav)}">`],
    ['<span class="sr-only">Language</span>', `<span class="sr-only">${c.language}</span>`],
    ['aria-label="Language"', `aria-label="${escAttr(c.language)}"`],
    [">How it works<", `>${c.navHow}<`], [">Under the hood<", `>${c.navInside}<`], [">Docs<", `>${c.docs}<`], [">Blog<", `>${c.blog}<`], [">Changelog<", `>${c.changelog}<`],
    [">Get started<", `>${c.getStarted}<`], [">See how it works<", `>${c.seeHow}<`], [">Read the docs<", `>${c.readDocs}<`], [">Benchmark<", `>${c.benchmark}<`],
    ['<span class="eyebrow rise">project memory for AI coding assistants</span>', `<span class="eyebrow rise">${c.releaseEyebrow}</span>`],
    ['<h1 class="rise d1">Your AI can read the code.<br /><b>Hunch explains why it is that way.</b></h1>', `<h1 class="rise d1">${c.heroTitle}</h1>`],
    ['<p class="lede rise d2">Hunch gives Claude, Cursor, Codex, and other coding assistants the decisions, bug fixes, and warnings your team learned before they change your code.</p>', `<p class="lede rise d2">${c.heroLede}</p>`],
    ['<p class="hero-note rise d2">It works with the AI tools you already use. It is not another model, and it does not send your project memory to a Hunch service.</p>', `<p class="hero-note rise d2">${c.heroNote}</p>`],
    ['<span class="eyebrow">what improved in v1.19</span>', `<span class="eyebrow">${c.releaseProofEyebrow}</span>`],
    ['<h2 id="release-proof-title">Find the likely code sooner. Inspect less.</h2>', `<h2 id="release-proof-title">${c.releaseProofTitle}</h2>`],
    ['<p class="release-copy">In a 12-problem test on unfamiliar code, Hunch found the changed piece of code in 6 cases instead of 3. In a separate test, it kept the same five successful finds while asking developers to inspect 41.9% less code.</p>', `<p class="release-copy">${c.releaseProofBody}</p>`],
    ['aria-label="Plain-language version 1.19 test results"', `aria-label="${escAttr(c.releaseMetricsAria)}"`],
    ['<span>problems where the changed code was found</span>', `<span>${c.releaseDeclaration}</span>`],
    ['<span>problems where the correct file was found</span>', `<span>${c.releaseFile}</span>`],
    ['<span>pieces of code to inspect on average</span>', `<span>${c.releaseInspection}</span>`],
    ['<p class="release-caveat">These were small, controlled tests—not a promise that Hunch is twice as accurate everywhere. When it only knows where to investigate, Hunch says so instead of pretending it knows the exact fix.</p>', `<p class="release-caveat">${c.releaseCaveat}</p>`],
    ['<span class="eyebrow">a familiar story</span>', `<span class="eyebrow">${c.storyEyebrow}</span>`],
    ['<h2>The bug was fixed. The reason was not.</h2>', `<h2>${c.storyTitle}</h2>`],
    ['<p>A non-obvious safeguard survives in the code. The story behind it slowly disappears.</p>', `<p>${c.storyIntro}</p>`],
    ['<span class="story-when">Monday</span>', `<span class="story-when">${c.monday}</span>`],
    ['<span class="story-when">Months later</span>', `<span class="story-when">${c.monthsLater}</span>`],
    ['<span class="story-when">Next session</span>', `<span class="story-when">${c.nextSession}</span>`],
    ['<span class="story-when">With Hunch</span>', `<span class="story-when">${c.withHunch}</span>`],
    ['<h3>A team solves a painful logout bug.</h3>', `<h3>${c.story1Title}</h3>`],
    ['<p>They move sessions server-side so a leaked token can be revoked immediately. The choice adds complexity, but it closes the hole.</p>', `<p>${c.story1Body}</p>`],
    ['<h3>The code remains. The context fades.</h3>', `<h3>${c.story2Title}</h3>`],
    ['<p>The incident is buried in an old pull request. Two people have changed teams. The unusual session flow now looks like needless machinery.</p>', `<p>${c.story2Body}</p>`],
    ['<h3>An AI assistant offers to “simplify” it.</h3>', `<h3>${c.story3Title}</h3>`],
    ['<p>The change is tidy and locally correct. It also reopens the exact failure the team already paid to understand.</p>', `<p>${c.story3Body}</p>`],
    ['<h3>The reason arrives before the edit.</h3>', `<h3>${c.story4Title}</h3>`],
    ['<p>The assistant sees what was chosen, what was rejected, and which bug the choice prevents. It takes a better path without asking the team to retell the story.</p>', `<p>${c.story4Body}</p>`],
    ['aria-label="Example project memory card"', `aria-label="${escAttr(c.receiptAria)}"`],
    ['<div class="receipt-head"><span>before editing · <bdi>src/auth/session.ts</bdi></span><b>memory found</b></div>', `<div class="receipt-head"><span>${c.beforeEditing} · <bdi>src/auth/session.ts</bdi></span><b>${c.memoryFound}</b></div>`],
    ['<span class="receipt-kicker">Why this code exists</span>', `<span class="receipt-kicker">${c.whyExists}</span>`],
    ['<h3>Logout must revoke access immediately.</h3>', `<h3>${c.logoutTitle}</h3>`],
    ['<div class="receipt-row"><span>chosen</span><p>Keep sessions server-side and let tokens carry only an opaque ID.</p></div>', `<div class="receipt-row"><span>${c.chosen}</span><p>${c.chosenBody}</p></div>`],
    ['<div class="receipt-row"><span>rejected</span><p>JWT-only sessions; they remain valid after logout until they expire.</p></div>', `<div class="receipt-row"><span>${c.rejected}</span><p>${c.rejectedBody}</p></div>`],
    ['<div class="receipt-row"><span>protects</span><p>Leaked token usable after a user resets their session.</p></div>', `<div class="receipt-row"><span>${c.protects}</span><p>${c.protectsBody}</p></div>`],
    ['<p class="receipt-foot">advisory · decision and bug attached as evidence</p>', `<p class="receipt-foot">${c.receiptFoot}</p>`],
    ['<span class="eyebrow">what Hunch does</span>', `<span class="eyebrow">${c.changesEyebrow}</span>`],
    ['<h2>It gives every coding assistant the same project memory.</h2>', `<h2>${c.changesTitle}</h2>`],
    ['<p>Hunch saves what your team learns, brings it back before an edit, and warns when a change could repeat an old mistake.</p>', `<p>${c.changesIntro}</p>`],
    ['<span class="step-n">01 / save</span>', `<span class="step-n">${c.rememberLabel}</span>`], ['<h3>Keep what the team learned.</h3>', `<h3>${c.rememberTitle}</h3>`],
    ['<p>Decisions, test failures, and your corrections become project memory instead of disappearing into old chats and pull requests.</p>', `<p>${c.rememberBody}</p>`],
    ['<span class="step-n">02 / remind</span>', `<span class="step-n">${c.recallLabel}</span>`], ['<h3>Explain before changing code.</h3>', `<h3>${c.recallTitle}</h3>`],
    ['<p>The assistant sees why a file is built this way, what depends on it, and what broke there before.</p>', `<p>${c.recallBody}</p>`],
    ['<span class="step-n">03 / warn</span>', `<span class="step-n">${c.protectLabel}</span>`], ['<h3>Catch repeated mistakes.</h3>', `<h3>${c.protectTitle}</h3>`],
    ['<p>If a change goes against a trusted decision or reopens a known bug, Hunch explains the conflict. Blocking is optional.</p>', `<p>${c.protectBody}</p>`],
    ['<span class="eyebrow">what happens behind the scenes</span>', `<span class="eyebrow">${c.underEyebrow}</span>`], ['<h2>Hunch stays under your control and shows its work.</h2>', `<h2>${c.underTitle}</h2>`],
    ['<p>Your project memory is made of readable files you can review and undo. Hunch connects each saved reason to the code it affects and includes the source with every answer.</p>', `<p>${c.underIntro}</p>`],
    ['<code class="literal">saved with Git</code>', `<code class="literal">${c.savedWithGit}</code>`], ['<code>code connections</code>', `<code>${c.codeGraph}</code>`], ['<code>your AI tools</code>', `<code>${c.mcpRules}</code>`], ['<code>clear rules</code>', `<code>${c.conformance}</code>`], ['<code>source included</code>', `<code>${c.provenance}</code>`], ['<code>no Hunch cloud</code>', `<code>${c.localFirst}</code>`],
    ['<h3>Memory you can inspect</h3>', `<h3>${c.gitMemoryTitle}</h3>`], ['<p>Decisions are saved as plain files. Your team can review, compare, and undo them just like code.</p>', `<p>${c.gitMemoryBody}</p>`],
    ['<h3>Knows what a change may affect</h3>', `<h3>${c.blastTitle}</h3>`], ['<p>Hunch follows the connections between files and functions so the right reason appears in the right place.</p>', `<p>${c.blastBody}</p>`],
    ['<h3>One memory across assistants</h3>', `<h3>${c.assistantsTitle}</h3>`], ['<p>Claude Code, Cursor, VS Code, Windsurf, Codex, and others can all use the same project memory.</p>', `<p>${c.assistantsBody}</p>`],
    ['<h3>Checks the same rule every time</h3>', `<h3>${c.checksTitle}</h3>`], ['<p>For rules your team chooses to trust, Hunch checks the code directly instead of asking another AI to guess.</p>', `<p>${c.checksBody}</p>`],
    ['<h3>Shows where answers came from</h3>', `<h3>${c.receiptsTitle}</h3>`], ['<p>Every answer points back to the decision, bug, commit, or correction that supports it.</p>', `<p>${c.receiptsBody}</p>`],
    ['<h3>Your memory stays yours</h3>', `<h3>${c.yoursTitle}</h3>`], ['<p>Hunch does not require a hosted account. Keep memory in your project or in a private Git repository your team controls.</p>', `<p>${c.yoursBody}</p>`],
    ['<p class="tech-link">Want the technical details? <a href="/docs">Read how Hunch works →</a></p>', `<p class="tech-link">${c.shortVersion} <a href="/docs">${c.explore}</a></p>`],
    ['<span class="eyebrow">get started</span>', `<span class="eyebrow">${c.startEyebrow}</span>`], ['<h2>Give your next AI session a memory.</h2>', `<h2>${c.startTitle}</h2>`],
    ['<h3>Install Hunch</h3>', `<h3>${c.installTitle}</h3>`], ['<p>One command reads your project and connects the coding assistants you already use.</p>', `<p>${c.installBody}</p>`],
    ['<h3>Add recent history</h3>', `<h3>${c.historyTitle}</h3>`], ['<p><code>hunch backfill --since 90d</code> finds useful decisions and lessons in the last 90 days of commits.</p>', `<p>${c.historyBody}</p>`],
    ['<h3>Ask a real question</h3>', `<h3>${c.askTitle}</h3>`], ['<p>Try <em>“why is the session module built this way?”</em> Your assistant answers from the team\'s history, with evidence.</p>', `<p>${c.askBody}</p>`],
    ['aria-label="Supported assistants"', `aria-label="${escAttr(c.supportedAria)}"`],
    ['<span class="c-key"># install from npm — Node 22.13+</span>', `<span class="c-key">${c.installComment}</span>`], ['<span class="c-key"># connect Hunch to this project and your assistants</span>', `<span class="c-key">${c.initComment}</span>`],
    ['<span class="c-key"># optionally learn from the last 90 days</span>', `<span class="c-key">${c.backfillComment}</span>`], ['<span class="c-key"># ask what a file is for</span>', `<span class="c-key">${c.whyComment}</span>`],
    ['<button class="copybtn" data-copy="#install-cmd">copy</button>', `<button class="copybtn" data-copy="#install-cmd">${c.copy}</button>`],
    ['Claude Code? Install as a plugin instead:<br />', `${c.pluginPrompt}<br />`],
    ['<h2>Make your codebase remember why.</h2>', `<h2>${c.ctaTitle}</h2>`], ['<p>Keep the decisions your team already made available to every person and every assistant that comes next.</p>', `<p>${c.ctaBody}</p>`],
    ['<p class="about">Git stores the code. Hunch stores the decisions, bug fixes, and warnings that explain why the code is that way.</p>', `<p class="about">${c.about}</p>`],
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
  html = replaceRequired(html, '<meta property="og:url" content="https://hunch-pi.vercel.app/" />', `<meta property="og:url" content="${siteOrigin}/${locale}" />`, locale);
  html = replaceRequired(html, '<meta property="og:locale" content="en_US" />', `<meta property="og:locale" content="${copy.ogLocale}" />`, locale);
  html = replaceRequired(html, '<link rel="canonical" href="https://hunch-pi.vercel.app/" />', `<link rel="canonical" href="${siteOrigin}/${locale}" />`, locale);
  html = replaceRequired(html, '<a class="brand" href="/">', `<a class="brand" href="/${locale}">`, locale);
  html = replaceRequired(html, '<option value="/" selected>EN</option>', '<option value="/">EN</option>', locale);
  html = replaceRequired(html, `<option value="/${locale}">${locale.toUpperCase()}</option>`, `<option value="/${locale}" selected>${locale.toUpperCase()}</option>`, locale);
  for (const [from, to] of fragments(copy)) html = replaceRequired(html, from, to, locale);
  html = html.replaceAll('href="/blog/"', `href="/${locale}/blog"`);
  html = html.replaceAll('href="/changelog"', `href="/${locale}/changelog"`);
  html = html.replace("<!DOCTYPE html>", `<!DOCTYPE html>\n<!-- Generated by tooling/generate-site-locales.mjs. Edit site/index.html or the locale dictionary, then regenerate. -->`);

  const banned = ["project memory for AI coding assistants", "Your AI can read the code", "what improved in v1.19", "problems where the changed code was found", "These were small, controlled tests", "The bug was fixed", "A team solves", "what Hunch does", "what happens behind the scenes", "Hunch stays under your control", "Memory you can inspect", "Install Hunch", "Make your codebase remember why"];
  const visibleHtml = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const phrase of banned) if (visibleHtml.includes(phrase)) throw new Error(`[${locale}] untranslated visible phrase: ${phrase}`);

  const targetDir = path.join(repoRoot, "site", locale);
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, "index.html"), html, "utf8");
  console.log(`generated site/${locale}/index.html (${copy.dir})`);
}

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
  html = replaceRequired(html, isPost ? "<title>The Hunch Blog</title>" : "<title>The Hunch Blog — Architectural Conformance for AI code</title>", `<title>${ui.pageTitle}</title>`, `${locale}/${page}`);
  html = replaceRequired(html,
    isPost ? '<meta name="description" content="Architectural Conformance for AI code — notes, benchmarks and arguments." />' : '<meta name="description" content="Notes, benchmarks and arguments on keeping AI-generated code inside your architecture — the semantic invariants pattern-SAST can\'t express." />',
    `<meta name="description" content="${escAttr(ui.pageDescription)}" />`, `${locale}/${page}`);
  html = replaceRequired(html,
    isPost ? '<link rel="canonical" id="canonical-url" href="https://hunch-pi.vercel.app/blog/post" />' : '<link rel="canonical" href="https://hunch-pi.vercel.app/blog" />',
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
  html = replaceRequired(html, "<title>Changelog — Hunch</title>", `<title>${ui.pageTitle}</title>`, `${locale}/changelog`);
  html = replaceRequired(html, '<meta name="description" content="Every Hunch release — git-native engineering memory and Architectural Conformance for AI code." />', `<meta name="description" content="${escAttr(ui.pageDescription)}" />`, `${locale}/changelog`);
  html = replaceRequired(html, '<link rel="canonical" href="https://hunch-pi.vercel.app/changelog" />', `<link rel="canonical" href="${siteOrigin}${route}" />`, `${locale}/changelog`);
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
