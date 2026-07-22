import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blogLocales } from "./blog-locales.mjs";
import { changelogLocales } from "./changelog-locales.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "site", "index.html");
const siteOrigin = "https://hunch-pi.vercel.app";

const locales = {
  he: {
    dir: "rtl",
    ogLocale: "he_IL",
    title: "Hunch — בסיס הקוד שלך זוכר למה",
    description: "Hunch מעניק ל-AI את הזיכרון ההנדסי שמאחורי הקוד — ההחלטות, הפשרות והבאגים שהצוות שלכם כבר למד מהם.",
    ogDescription: "תנו לכל סשן קידוד עם AI את ההחלטות, הפשרות והלקחים שהצוות כבר צבר.",
    mainNav: "ניווט ראשי", language: "שפה",
    navHow: "כך זה עובד", navInside: "מאחורי הקלעים", docs: "תיעוד", blog: "בלוג", changelog: "יומן שינויים",
    getStarted: "מתחילים", seeHow: "כך זה עובד", readDocs: "קריאת התיעוד", benchmark: "מדד ביצועים",
    releaseEyebrow: "v1.9 · זיכרון צוות משותף", heroTitle: "תנו ל-AI את<br /><b>הזיכרון של הצוות.</b>",
    heroLede: "Hunch נותן לכל סוכן קוד את ההחלטות, הפשרות והלקחים שנצברו מאחורי הקוד—כך שכל סשן מתחיל עם מה שהצוות כבר יודע.",
    storyEyebrow: "סיפור מוכר", storyTitle: "הבאג תוקן. הסיבה נשכחה.", storyIntro: "מנגנון הגנה לא מובן מאליו נשאר בקוד. הסיפור שמאחוריו הולך ונעלם.",
    monday: "יום שני", monthsLater: "כעבור חודשים", nextSession: "בסשן הבא", withHunch: "עם Hunch",
    story1Title: "הצוות פותר באג התנתקות כואב.", story1Body: "הם מעבירים את הסשנים לשרת כדי שאפשר יהיה לבטל מיד טוקן שדלף. הבחירה מוסיפה מורכבות, אבל סוגרת את הפרצה.",
    story2Title: "הקוד נשאר. ההקשר דוהה.", story2Body: "האירוע קבור ב-pull request ישן. שני אנשים עברו לצוותים אחרים. זרימת הסשן החריגה נראית עכשיו כמו מנגנון מיותר.",
    story3Title: "עוזר AI מציע „לפשט” אותו.", story3Body: "השינוי נקי ונכון מקומית. הוא גם פותח מחדש בדיוק את הכשל שהצוות כבר שילם כדי להבין.",
    story4Title: "הסיבה מגיעה לפני העריכה.", story4Body: "העוזר רואה מה נבחר, מה נדחה ואיזה באג הבחירה מונעת. הוא בוחר דרך טובה יותר בלי לבקש מהצוות לספר שוב את הסיפור.",
    receiptAria: "דוגמה לקבלת זיכרון הנדסי", beforeEditing: "לפני עריכת", memoryFound: "נמצא זיכרון", whyExists: "למה הקוד הזה קיים",
    logoutTitle: "התנתקות חייבת לבטל גישה מיד.", chosen: "נבחר", chosenBody: "לשמור סשנים בצד השרת ולאפשר לטוקנים לשאת רק מזהה אטום.",
    rejected: "נדחה", rejectedBody: "סשנים המבוססים רק על JWT; הם נשארים תקפים אחרי התנתקות עד שפג תוקפם.",
    protects: "מגן מפני", protectsBody: "שימוש בטוקן שדלף אחרי שהמשתמש איפס את הסשן שלו.", receiptFoot: "ייעוץ בלבד · ההחלטה והבאג מצורפים כראיות",
    changesEyebrow: "מה משתנה", changesTitle: "העוזר מתחיל עם הזיכרון של הצוות.", changesIntro: "Hunch לומד מהעבודה ההנדסית הרגילה ומחזיר את החלק הרלוונטי בדיוק ברגע שבו הוא נדרש.",
    rememberLabel: "01 / לזכור", rememberTitle: "העבודה משאירה עקבות.", rememberBody: "קומיטים, כשלי בדיקות והתיקונים שלכם הופכים להחלטות, באגים וכללים שנשמרים לאורך זמן—בלי טקס תיעוד נפרד.",
    recallLabel: "02 / להיזכר", recallTitle: "ההקשר הנכון מופיע.", recallBody: "לפני שינוי קובץ, העוזר רואה למה הוא בנוי כך, מה תלוי בו ומה כבר נכשל שם בעבר.",
    protectLabel: "03 / להגן", protectTitle: "טעויות ישנות נשארות לקח.", protectBody: "Hunch מסמן בשקט נסיגה ומסביר למה. אתם מחליטים מה קורה עכשיו; חסימה מופעלת רק אם בוחרים בה.",
    underEyebrow: "מאחורי הקלעים", underTitle: "מקומי בליבה. מדויק כשזה חשוב.", underIntro: "מאחורי הסיפור הפשוט עומדים גרף קוד דטרמיניסטי ורשומות ברורות שאפשר לסקור. Hunch מסביר את התשובה—ומציג את הראיות שמאחוריה.",
    codeGraph: "גרף קוד", mcpRules: "MCP + כללים", conformance: "התאמה", provenance: "מקור", localFirst: "מקומי תחילה",
    gitMemoryTitle: "זיכרון שנשמר ב-Git", gitMemoryBody: "שמרו את הזיכרון לצד הקוד או חברו את כל הצוות למאגר Git פרטי ייעודי אחד. עותקים חדשים מגלים אותו דרך מצביע ללא פרטי גישה.",
    blastTitle: "טווח השפעה אמיתי", blastBody: "סמלים, קוראים, רכיבים ותלויות מחברים את הסיבה לקוד שעליו היא מגנה.",
    assistantsTitle: "עובד עם עוזרים שונים", assistantsBody: "Claude Code, Cursor, VS Code, Windsurf, Codex ואחרים קוראים מאותו זיכרון.",
    checksTitle: "בדיקות דטרמיניסטיות", checksBody: "שכבות, מסלולים שחייבים להתקיים, גישות שנדחו ורגרסיות מוכרות נבדקים בלי פסק דין של LLM.",
    receiptsTitle: "ראיות, לא ניחושים", receiptsBody: "כל תשובה כוללת מקור, רמת ביטחון, קומיט וההיסטוריה שמאחורי ההמלצה.",
    yoursTitle: "הזיכרון נשאר שלכם", yoursBody: "אין צורך ב-SaaS. ידע פרטי יכול להישמר בשכבה נפרדת שנמצאת בשליטתכם.",
    shortVersion: "זו הגרסה הקצרה.", explore: "לארכיטקטורה ולכל היכולות ←",
    startEyebrow: "מתחילים", startTitle: "תנו לסשן ה-AI הבא שלכם זיכרון.",
    installTitle: "התקנה ואתחול", installBody: "פקודה אחת מאנדקסת את המאגר, מחברת את העוזרים הנתמכים ושומרת את הזיכרון לצד הקוד.",
    historyTitle: "קחו את העבר הקרוב איתכם", historyBody: "<code>hunch backfill --since 90d</code> הופך את ההיסטוריה האחרונה לזיכרון שימושי כבר מהיום הראשון.",
    askTitle: "שאלו שאלה אמיתית", askBody: "נסו <em>„למה מודול הסשן בנוי כך?”</em> העוזר עונה מתוך ההיסטוריה של הצוות ומצרף ראיות.",
    supportedAria: "עוזרים נתמכים", installComment: "# התקנה מ-npm — נדרש Node 22.13+", initComment: "# אינדוקס + hooks + חיבור כל העוזרים", backfillComment: "# התחלה קרה: חילוץ החלטות מההיסטוריה", whyComment: "# ה'למה' שמאחורי כל קובץ או סמל",
    copy: "העתקה", copied: "הועתק", pluginPrompt: "משתמשים ב-Claude Code? התקינו במקום זאת כתוסף:",
    ctaTitle: "תנו לבסיס הקוד לזכור למה.", ctaBody: "השאירו את ההחלטות שהצוות כבר קיבל זמינות לכל אדם ולכל עוזר שיגיעו בהמשך.",
    about: "Git שומר מה יש בקוד. Hunch שומר למה — גרף חשיבה מתמשך שנשמר ב-Git לעידן ההנדסה עם AI.",
    product: "מוצר", develop: "פיתוח", connect: "קישורים", mcpTools: "כלי MCP", vscodeExtension: "תוסף ל-VS Code",
    canvasDecision: "החלטה", canvasBug: "באג", canvasRule: "כלל", canvasWhy: "למה", canvasReason: "הסיבה נשלפה לפני העריכה", held: "נשמר", blocked: "נחסם",
  },
  ru: {
    dir: "ltr", ogLocale: "ru_RU",
    title: "Hunch — ваша кодовая база помнит почему",
    description: "Hunch даёт ИИ инженерную память о коде: решения, компромиссы и ошибки, на которых ваша команда уже научилась.",
    ogDescription: "Передайте каждому сеансу разработки с ИИ решения, компромиссы и накопленный опыт вашей команды.",
    mainNav: "Основная навигация", language: "Язык",
    navHow: "Как это работает", navInside: "Что внутри", docs: "Документация", blog: "Блог", changelog: "История изменений",
    getStarted: "Начать", seeHow: "Посмотреть, как это работает", readDocs: "Читать документацию", benchmark: "Бенчмарк",
    releaseEyebrow: "v1.9 · общая память команды", heroTitle: "Дайте ИИ<br /><b>память вашей команды.</b>",
    heroLede: "Hunch передаёт каждому агенту разработки решения, компромиссы и накопленный опыт, стоящий за вашим кодом, — чтобы каждый сеанс начинался с того, что команда уже знает.",
    storyEyebrow: "знакомая история", storyTitle: "Ошибку исправили. Причину забыли.", storyIntro: "В коде остаётся неочевидная защита. История её появления постепенно исчезает.",
    monday: "Понедельник", monthsLater: "Через несколько месяцев", nextSession: "Следующий сеанс", withHunch: "С Hunch",
    story1Title: "Команда исправляет болезненную ошибку выхода.", story1Body: "Сессии переносят на сервер, чтобы скомпрометированный токен можно было немедленно отозвать. Решение усложняет систему, но закрывает уязвимость.",
    story2Title: "Код остаётся. Контекст стирается.", story2Body: "Инцидент затерялся в старом pull request. Два человека перешли в другие команды. Необычный поток сессии теперь выглядит ненужным усложнением.",
    story3Title: "ИИ-помощник предлагает всё «упростить».", story3Body: "Изменение аккуратно и локально корректно. Но оно снова открывает тот самый дефект, за понимание которого команда уже заплатила.",
    story4Title: "Причина появляется до правки.", story4Body: "Помощник видит, что выбрали, что отвергли и какую ошибку предотвращает решение. Он выбирает лучший путь, не заставляя команду пересказывать историю.",
    receiptAria: "Пример карточки инженерной памяти", beforeEditing: "перед изменением", memoryFound: "память найдена", whyExists: "Почему существует этот код",
    logoutTitle: "Выход должен немедленно отзывать доступ.", chosen: "выбрано", chosenBody: "Хранить сессии на сервере, а в токене оставлять только непрозрачный идентификатор.",
    rejected: "отвергнуто", rejectedBody: "Сессии только на JWT: после выхода они действуют до истечения срока токена.",
    protects: "защищает от", protectsBody: "Использования украденного токена после сброса пользовательской сессии.", receiptFoot: "рекомендация · решение и ошибка приложены как доказательства",
    changesEyebrow: "что меняется", changesTitle: "Помощник начинает с памяти команды.", changesIntro: "Hunch учится на обычной инженерной работе и возвращает нужный фрагмент памяти именно тогда, когда он важен.",
    rememberLabel: "01 / запомнить", rememberTitle: "Работа оставляет след.", rememberBody: "Коммиты, падения тестов и ваши исправления становятся долговечными решениями, ошибками и правилами — без отдельного ритуала документирования.",
    recallLabel: "02 / вспомнить", recallTitle: "Нужный контекст появляется вовремя.", recallBody: "Перед изменением файла помощник видит, почему тот устроен именно так, что от него зависит и что здесь уже ломалось.",
    protectLabel: "03 / защитить", protectTitle: "Старые ошибки остаются усвоенными.", protectBody: "Hunch спокойно отмечает откат и объясняет причину. Что делать дальше, решаете вы; блокировка включается только по вашему выбору.",
    underEyebrow: "что внутри", underTitle: "Локально в основе. Точно в важный момент.", underIntro: "За простой историей стоят детерминированный граф кода и понятные записи, доступные для проверки. Hunch объясняет ответ и показывает доказательства.",
    codeGraph: "граф кода", mcpRules: "MCP + правила", conformance: "соответствие", provenance: "происхождение", localFirst: "сначала локально",
    gitMemoryTitle: "Память в Git", gitMemoryBody: "Храните память рядом с кодом или подключите всю команду к одному выделенному приватному Git-репозиторию. Новые клоны находят его по указателю без учётных данных.",
    blastTitle: "Реальный радиус изменений", blastBody: "Символы, вызовы, компоненты и зависимости связывают причину с кодом, который она защищает.",
    assistantsTitle: "Работает с разными помощниками", assistantsBody: "Claude Code, Cursor, VS Code, Windsurf, Codex и другие читают одну и ту же память.",
    checksTitle: "Детерминированные проверки", checksBody: "Слои, обязательные пути, отвергнутые подходы и известные регрессии проверяются без вердикта LLM.",
    receiptsTitle: "Доказательства вместо догадок", receiptsBody: "Каждый ответ содержит источник, уверенность, коммит и историю, на которой основана рекомендация.",
    yoursTitle: "Ваша память остаётся вашей", yoursBody: "SaaS не требуется. Приватные знания могут жить в отдельном слое под вашим контролем.",
    shortVersion: "Это краткая версия.", explore: "Изучить архитектуру и все возможности →",
    startEyebrow: "начало работы", startTitle: "Дайте память следующему сеансу с ИИ.",
    installTitle: "Установите и инициализируйте", installBody: "Одна команда индексирует репозиторий, подключает поддерживаемых помощников и хранит память рядом с кодом.",
    historyTitle: "Возьмите недавнее прошлое с собой", historyBody: "<code>hunch backfill --since 90d</code> превращает недавнюю историю в полезную память уже в первый день.",
    askTitle: "Задайте настоящий вопрос", askBody: "Спросите: <em>«Почему модуль сессий устроен именно так?»</em> Помощник ответит из истории команды и приложит доказательства.",
    supportedAria: "Поддерживаемые помощники", installComment: "# установка из npm — требуется Node 22.13+", initComment: "# индекс + hooks + подключение всех помощников", backfillComment: "# холодный старт: извлечь решения из истории", whyComment: "# «почему» за каждым файлом или символом",
    copy: "копировать", copied: "скопировано", pluginPrompt: "Используете Claude Code? Установите плагин:",
    ctaTitle: "Пусть кодовая база помнит почему.", ctaBody: "Сохраните уже принятые решения доступными каждому человеку и каждому помощнику, которые придут после вас.",
    about: "Git хранит, что находится в коде. Hunch хранит почему — постоянный граф рассуждений в Git для эпохи разработки с ИИ.",
    product: "продукт", develop: "разработка", connect: "ссылки", mcpTools: "Инструменты MCP", vscodeExtension: "Расширение VS Code",
    canvasDecision: "решение", canvasBug: "ошибка", canvasRule: "правило", canvasWhy: "почему", canvasReason: "причина найдена до правки", held: "сохранено", blocked: "заблокировано",
  },
  ar: {
    dir: "rtl", ogLocale: "ar",
    title: "Hunch — قاعدة شيفرتك تتذكّر السبب",
    description: "يمنح Hunch الذكاء الاصطناعي الذاكرة الهندسية وراء شيفرتك: القرارات والمفاضلات والأخطاء التي تعلّم منها فريقك بالفعل.",
    ogDescription: "امنح كل جلسة برمجة بالذكاء الاصطناعي قرارات فريقك ومفاضلاته ودروسه المتراكمة.",
    mainNav: "التنقّل الرئيسي", language: "اللغة",
    navHow: "كيف يعمل", navInside: "ما وراء الواجهة", docs: "الوثائق", blog: "المدوّنة", changelog: "سجل التغييرات",
    getStarted: "ابدأ الآن", seeHow: "شاهد كيف يعمل", readDocs: "اقرأ الوثائق", benchmark: "اختبار الأداء",
    releaseEyebrow: "v1.9 · ذاكرة فريق مشتركة", heroTitle: "امنح الذكاء الاصطناعي<br /><b>ذاكرة فريقك.</b>",
    heroLede: "يمنح Hunch كل وكيل برمجة القرارات والمفاضلات والدروس المتراكمة وراء شيفرتك، لتبدأ كل جلسة بما يعرفه فريقك مسبقًا.",
    storyEyebrow: "قصة مألوفة", storyTitle: "أُصلح الخطأ. وضاع السبب.", storyIntro: "تبقى آلية حماية غير بديهية في الشيفرة، بينما تتلاشى قصتها ببطء.",
    monday: "يوم الاثنين", monthsLater: "بعد أشهر", nextSession: "الجلسة التالية", withHunch: "مع Hunch",
    story1Title: "يعالج الفريق خطأً مؤلمًا في تسجيل الخروج.", story1Body: "ينقل الفريق الجلسات إلى الخادم كي يتمكّن من إبطال الرمز المسرّب فورًا. يضيف القرار بعض التعقيد، لكنه يغلق الثغرة.",
    story2Title: "تبقى الشيفرة. ويتلاشى السياق.", story2Body: "تُدفن الحادثة في pull request قديم، وينتقل شخصان إلى فريقين آخرين. ويبدو مسار الجلسة غير المعتاد الآن كأنه تعقيد بلا داعٍ.",
    story3Title: "يقترح مساعد ذكاء اصطناعي «تبسيطها».", story3Body: "التغيير مرتب وصحيح محليًا، لكنه يعيد فتح العطل نفسه الذي دفع الفريق ثمن فهمه.",
    story4Title: "يصل السبب قبل التعديل.", story4Body: "يرى المساعد ما اختير وما رُفض وأي خطأ يمنعه القرار. فيسلك طريقًا أفضل من دون أن يطلب من الفريق رواية القصة من جديد.",
    receiptAria: "مثال على بطاقة ذاكرة هندسية", beforeEditing: "قبل تعديل", memoryFound: "وُجدت ذاكرة", whyExists: "لماذا توجد هذه الشيفرة",
    logoutTitle: "يجب أن يلغي تسجيل الخروج الوصول فورًا.", chosen: "المختار", chosenBody: "الاحتفاظ بالجلسات على الخادم، وجعل الرموز تحمل معرّفًا مبهمًا فقط.",
    rejected: "المرفوض", rejectedBody: "جلسات تعتمد على JWT فقط؛ تبقى صالحة بعد تسجيل الخروج حتى انتهاء الرمز.",
    protects: "يحمي من", protectsBody: "استخدام رمز مسرّب بعد أن يعيد المستخدم ضبط جلسته.", receiptFoot: "إرشادي · القرار والخطأ مرفقان كدليل",
    changesEyebrow: "ما الذي يتغيّر", changesTitle: "يبدأ المساعد بذاكرة الفريق.", changesIntro: "يتعلّم Hunch من العمل الهندسي المعتاد، ثم يعيد الجزء المناسب من الذاكرة في اللحظة التي تحتاج إليه.",
    rememberLabel: "01 / تذكّر", rememberTitle: "يترك العمل أثرًا.", rememberBody: "تتحول الـ commits وأعطال الاختبارات وتصحيحاتكم إلى قرارات وأخطاء وقواعد دائمة، من دون طقس توثيق منفصل.",
    recallLabel: "02 / استرجع", recallTitle: "يظهر السياق المناسب.", recallBody: "قبل تغيير ملف، يرى المساعد لماذا بُني بهذه الطريقة، وما الذي يعتمد عليه، وما الذي تعطل هنا من قبل.",
    protectLabel: "03 / احمِ", protectTitle: "تبقى الأخطاء القديمة دروسًا مستفادة.", protectBody: "يشير Hunch بهدوء إلى التراجع ويشرح سببه. أنتم تقررون ما يحدث بعد ذلك؛ والحظر اختياري.",
    underEyebrow: "ما وراء الواجهة", underTitle: "محلي في جوهره. دقيق حين يهم.", underIntro: "تدعم القصة البسيطة خريطة حتمية للشيفرة وسجلات واضحة قابلة للمراجعة. يشرح Hunch إجابته ويعرض الدليل وراءها.",
    codeGraph: "خريطة الشيفرة", mcpRules: "MCP + قواعد", conformance: "المطابقة", provenance: "المصدر", localFirst: "محلي أولًا",
    gitMemoryTitle: "ذاكرة داخل Git", gitMemoryBody: "احتفظ بالذاكرة بجانب الشيفرة أو اربط الفريق كله بمستودع Git خاص ومخصص واحد. تكتشفه النسخ الجديدة عبر مؤشر خالٍ من بيانات الاعتماد.",
    blastTitle: "نطاق تأثير حقيقي", blastBody: "تربط الرموز والاستدعاءات والمكوّنات والتبعيات السبب بالشيفرة التي يحكمها.",
    assistantsTitle: "يعمل عبر عدة مساعدين", assistantsBody: "يقرأ Claude Code وCursor وVS Code وWindsurf وCodex وغيرهم من الذاكرة نفسها.",
    checksTitle: "فحوصات حتمية", checksBody: "تُفحص الطبقات والمسارات الإلزامية والأساليب المرفوضة والتراجعات المعروفة من دون حكم صادر عن LLM.",
    receiptsTitle: "أدلة لا تخمينات", receiptsBody: "تحمل كل إجابة مصدرها ومستوى الثقة والـ commit والتاريخ وراء التوصية.",
    yoursTitle: "تبقى ذاكرتكم ملككم", yoursBody: "لا حاجة إلى SaaS. ويمكن للمعرفة الخاصة أن تعيش في طبقة منفصلة تتحكمون بها.",
    shortVersion: "هذه هي النسخة المختصرة.", explore: "استكشف البنية وكل الإمكانات ←",
    startEyebrow: "ابدأ", startTitle: "امنح جلسة الذكاء الاصطناعي التالية ذاكرة.",
    installTitle: "ثبّت وابدأ", installBody: "يفهرس أمر واحد المستودع، ويربط المساعدين المدعومين، ويحفظ الذاكرة بجانب الشيفرة.",
    historyTitle: "خذ الماضي القريب معك", historyBody: "يحوّل <code>hunch backfill --since 90d</code> التاريخ الحديث إلى ذاكرة مفيدة منذ اليوم الأول.",
    askTitle: "اطرح سؤالًا حقيقيًا", askBody: "جرّب: <em>«لماذا بُنيت وحدة الجلسات بهذه الطريقة؟»</em> يجيب مساعدك من تاريخ الفريق ويرفق الدليل.",
    supportedAria: "المساعدون المدعومون", installComment: "# التثبيت من npm — يتطلب Node 22.13+", initComment: "# فهرسة + hooks + ربط جميع المساعدين", backfillComment: "# بداية باردة: استخرج القرارات من التاريخ", whyComment: "# السبب وراء أي ملف أو رمز",
    copy: "نسخ", copied: "تم النسخ", pluginPrompt: "تستخدم Claude Code؟ ثبّته كإضافة بدلًا من ذلك:",
    ctaTitle: "اجعل قاعدة شيفرتك تتذكّر السبب.", ctaBody: "أبقِ القرارات التي اتخذها فريقك متاحة لكل شخص ولكل مساعد يأتي بعده.",
    about: "يحفظ Git ما في الشيفرة. ويحفظ Hunch السبب — خريطة تفكير دائمة داخل Git لعصر الهندسة بالذكاء الاصطناعي.",
    product: "المنتج", develop: "التطوير", connect: "روابط", mcpTools: "أدوات MCP", vscodeExtension: "إضافة VS Code",
    canvasDecision: "قرار", canvasBug: "خطأ", canvasRule: "قاعدة", canvasWhy: "لماذا", canvasReason: "استُعيد السبب قبل التعديل", held: "محفوظ", blocked: "محظور",
  },
  es: {
    dir: "ltr", ogLocale: "es_ES",
    title: "Hunch — tu código recuerda por qué",
    description: "Hunch aporta a la IA la memoria de ingeniería detrás de tu código: las decisiones, concesiones y errores de los que tu equipo ya aprendió.",
    ogDescription: "Da a cada sesión de programación con IA las decisiones, concesiones y lecciones acumuladas por tu equipo.",
    mainNav: "Navegación principal", language: "Idioma",
    navHow: "Cómo funciona", navInside: "Cómo está hecho", docs: "Documentación", blog: "Blog", changelog: "Cambios",
    getStarted: "Empezar", seeHow: "Ver cómo funciona", readDocs: "Leer la documentación", benchmark: "Benchmark",
    releaseEyebrow: "v1.9 · memoria compartida del equipo", heroTitle: "Dale a la IA<br /><b>la memoria de tu equipo.</b>",
    heroLede: "Hunch entrega a cada agente de código las decisiones, concesiones y lecciones aprendidas detrás de tu código, para que cada sesión empiece con lo que tu equipo ya sabe.",
    storyEyebrow: "una historia conocida", storyTitle: "El error se corrigió. La razón se perdió.", storyIntro: "Una protección poco obvia sobrevive en el código. La historia que la explica desaparece lentamente.",
    monday: "Lunes", monthsLater: "Meses después", nextSession: "Siguiente sesión", withHunch: "Con Hunch",
    story1Title: "Un equipo resuelve un doloroso error de cierre de sesión.", story1Body: "Mueven las sesiones al servidor para poder revocar de inmediato un token filtrado. La decisión añade complejidad, pero cierra la brecha.",
    story2Title: "El código permanece. El contexto se desvanece.", story2Body: "El incidente queda enterrado en un pull request antiguo. Dos personas cambian de equipo. El flujo inusual de la sesión ahora parece maquinaria innecesaria.",
    story3Title: "Un asistente de IA propone «simplificarlo».", story3Body: "El cambio es limpio y correcto de forma local. También reabre el mismo fallo que el equipo ya pagó por comprender.",
    story4Title: "La razón llega antes que la edición.", story4Body: "El asistente ve qué se eligió, qué se descartó y qué error evita la decisión. Toma un camino mejor sin pedir al equipo que vuelva a contar la historia.",
    receiptAria: "Ejemplo de recibo de memoria de ingeniería", beforeEditing: "antes de editar", memoryFound: "memoria encontrada", whyExists: "Por qué existe este código",
    logoutTitle: "Cerrar sesión debe revocar el acceso de inmediato.", chosen: "elegido", chosenBody: "Mantener las sesiones en el servidor y dejar que los tokens solo lleven un identificador opaco.",
    rejected: "descartado", rejectedBody: "Sesiones basadas solo en JWT; siguen siendo válidas tras cerrar sesión hasta que caducan.",
    protects: "protege de", protectsBody: "Usar un token filtrado después de que la persona restablezca su sesión.", receiptFoot: "orientativo · la decisión y el error se adjuntan como evidencia",
    changesEyebrow: "qué cambia", changesTitle: "Tu asistente empieza con la memoria del equipo.", changesIntro: "Hunch aprende del trabajo cotidiano de ingeniería y recupera la parte relevante justo cuando hace falta.",
    rememberLabel: "01 / recordar", rememberTitle: "El trabajo deja rastro.", rememberBody: "Los commits, los fallos de pruebas y tus correcciones se convierten en decisiones, errores y reglas duraderas, sin un ritual de documentación aparte.",
    recallLabel: "02 / recuperar", recallTitle: "Aparece el contexto adecuado.", recallBody: "Antes de cambiar un archivo, el asistente ve por qué tiene esa forma, qué depende de él y qué falló allí anteriormente.",
    protectLabel: "03 / proteger", protectTitle: "Los errores antiguos siguen aprendidos.", protectBody: "Hunch señala discretamente una reversión y explica por qué. Tú decides qué ocurre después; bloquear es opcional.",
    underEyebrow: "cómo está hecho", underTitle: "Local en el núcleo. Preciso cuando importa.", underIntro: "La historia sencilla se apoya en un grafo de código determinista y registros claros que se pueden revisar. Hunch explica su respuesta y muestra la evidencia.",
    codeGraph: "grafo de código", mcpRules: "MCP + reglas", conformance: "conformidad", provenance: "procedencia", localFirst: "local primero",
    gitMemoryTitle: "Memoria nativa de Git", gitMemoryBody: "Mantén la memoria junto al código o conecta a todo el equipo con un único repositorio Git privado y dedicado. Los clones nuevos lo descubren mediante un puntero sin credenciales.",
    blastTitle: "Impacto real", blastBody: "Los símbolos, llamadas, componentes y dependencias conectan la razón con el código que gobierna.",
    assistantsTitle: "Funciona con distintos asistentes", assistantsBody: "Claude Code, Cursor, VS Code, Windsurf, Codex y otros leen la misma memoria.",
    checksTitle: "Comprobaciones deterministas", checksBody: "Las capas, rutas obligatorias, enfoques descartados y regresiones conocidas se comprueban sin un veredicto de un LLM.",
    receiptsTitle: "Evidencia, no suposiciones", receiptsBody: "Cada respuesta incluye su fuente, nivel de confianza, commit y la historia detrás de la recomendación.",
    yoursTitle: "Tu memoria sigue siendo tuya", yoursBody: "No requiere SaaS. El conocimiento privado puede vivir en una capa separada que tú controlas.",
    shortVersion: "Esa es la versión breve.", explore: "Explora la arquitectura y todas las funciones →",
    startEyebrow: "primeros pasos", startTitle: "Dale memoria a tu próxima sesión de IA.",
    installTitle: "Instala e inicializa", installBody: "Un solo comando indexa el repositorio, conecta los asistentes compatibles y guarda la memoria junto al código.",
    historyTitle: "Llévate el pasado reciente", historyBody: "<code>hunch backfill --since 90d</code> convierte el historial reciente en una memoria útil desde el primer día.",
    askTitle: "Haz una pregunta real", askBody: "Prueba: <em>«¿Por qué está construido así el módulo de sesiones?»</em> Tu asistente responde desde la historia del equipo y aporta evidencia.",
    supportedAria: "Asistentes compatibles", installComment: "# instalación desde npm — requiere Node 22.13+", initComment: "# índice + hooks + conecta todos los asistentes", backfillComment: "# inicio en frío: extrae decisiones del historial", whyComment: "# el porqué detrás de cualquier archivo o símbolo",
    copy: "copiar", copied: "copiado", pluginPrompt: "¿Usas Claude Code? Instálalo como plugin:",
    ctaTitle: "Haz que tu código recuerde por qué.", ctaBody: "Mantén las decisiones que tu equipo ya tomó disponibles para cada persona y cada asistente que llegue después.",
    about: "Git guarda qué hay en el código. Hunch guarda por qué: un grafo de razonamiento persistente y nativo de Git para la era de la ingeniería con IA.",
    product: "producto", develop: "desarrollo", connect: "enlaces", mcpTools: "Herramientas MCP", vscodeExtension: "Extensión de VS Code",
    canvasDecision: "decisión", canvasBug: "error", canvasRule: "regla", canvasWhy: "por qué", canvasReason: "razón recuperada antes de editar", held: "conservado", blocked: "bloqueado",
  },
};

function escAttr(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function fragments(c) {
  return [
    ["<title>Hunch — your codebase remembers why</title>", `<title>${c.title}</title>`],
    ['content="Hunch gives AI the engineering memory behind your code — the decisions, trade-offs, and bugs your team already learned from."', `content="${escAttr(c.description)}"`],
    ['<meta property="og:title" content="Hunch — your codebase remembers why" />', `<meta property="og:title" content="${escAttr(c.title)}" />`],
    ['content="Give every AI coding session the decisions, trade-offs, and hard-won lessons behind your code."', `content="${escAttr(c.ogDescription)}"`],
    ['<nav class="nav" aria-label="Main">', `<nav class="nav" aria-label="${escAttr(c.mainNav)}">`],
    ['<span class="sr-only">Language</span>', `<span class="sr-only">${c.language}</span>`],
    ['aria-label="Language"', `aria-label="${escAttr(c.language)}"`],
    [">How it works<", `>${c.navHow}<`], [">Under the hood<", `>${c.navInside}<`], [">Docs<", `>${c.docs}<`], [">Blog<", `>${c.blog}<`], [">Changelog<", `>${c.changelog}<`],
    [">Get started<", `>${c.getStarted}<`], [">See how it works<", `>${c.seeHow}<`], [">Read the docs<", `>${c.readDocs}<`], [">Benchmark<", `>${c.benchmark}<`],
    ['<span class="eyebrow rise">v1.9 · shared team memory</span>', `<span class="eyebrow rise">${c.releaseEyebrow}</span>`],
    ['<h1 class="rise d1">Give AI your<br /><b>team\'s memory.</b></h1>', `<h1 class="rise d1">${c.heroTitle}</h1>`],
    ['<p class="lede rise d2">Hunch gives every coding agent the decisions, trade-offs, and hard-won lessons behind your code—so each session starts with what your team already knows.</p>', `<p class="lede rise d2">${c.heroLede}</p>`],
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
    ['aria-label="Example engineering memory receipt"', `aria-label="${escAttr(c.receiptAria)}"`],
    ['<div class="receipt-head"><span>before editing · <bdi>src/auth/session.ts</bdi></span><b>memory found</b></div>', `<div class="receipt-head"><span>${c.beforeEditing} · <bdi>src/auth/session.ts</bdi></span><b>${c.memoryFound}</b></div>`],
    ['<span class="receipt-kicker">Why this code exists</span>', `<span class="receipt-kicker">${c.whyExists}</span>`],
    ['<h3>Logout must revoke access immediately.</h3>', `<h3>${c.logoutTitle}</h3>`],
    ['<div class="receipt-row"><span>chosen</span><p>Keep sessions server-side and let tokens carry only an opaque ID.</p></div>', `<div class="receipt-row"><span>${c.chosen}</span><p>${c.chosenBody}</p></div>`],
    ['<div class="receipt-row"><span>rejected</span><p>JWT-only sessions; they remain valid after logout until they expire.</p></div>', `<div class="receipt-row"><span>${c.rejected}</span><p>${c.rejectedBody}</p></div>`],
    ['<div class="receipt-row"><span>protects</span><p>Leaked token usable after a user resets their session.</p></div>', `<div class="receipt-row"><span>${c.protects}</span><p>${c.protectsBody}</p></div>`],
    ['<p class="receipt-foot">advisory · decision and bug attached as evidence</p>', `<p class="receipt-foot">${c.receiptFoot}</p>`],
    ['<span class="eyebrow">what changes</span>', `<span class="eyebrow">${c.changesEyebrow}</span>`],
    ["<h2>Your assistant starts with the team's memory.</h2>", `<h2>${c.changesTitle}</h2>`],
    ['<p>Hunch learns from normal engineering work, then brings the relevant part back at the moment it matters.</p>', `<p>${c.changesIntro}</p>`],
    ['<span class="step-n">01 / remember</span>', `<span class="step-n">${c.rememberLabel}</span>`], ['<h3>Work leaves a trail.</h3>', `<h3>${c.rememberTitle}</h3>`],
    ['<p>Commits, test failures, and your corrections become durable decisions, bugs, and rules—without a separate documentation ritual.</p>', `<p>${c.rememberBody}</p>`],
    ['<span class="step-n">02 / recall</span>', `<span class="step-n">${c.recallLabel}</span>`], ['<h3>The right context shows up.</h3>', `<h3>${c.recallTitle}</h3>`],
    ['<p>Before changing a file, the assistant sees why it is shaped this way, what depends on it, and what has failed there before.</p>', `<p>${c.recallBody}</p>`],
    ['<span class="step-n">03 / protect</span>', `<span class="step-n">${c.protectLabel}</span>`], ['<h3>Old mistakes stay learned.</h3>', `<h3>${c.protectTitle}</h3>`],
    ['<p>Hunch quietly flags a reversal and explains why. You decide what happens next; blocking is opt-in.</p>', `<p>${c.protectBody}</p>`],
    ['<span class="eyebrow">under the hood</span>', `<span class="eyebrow">${c.underEyebrow}</span>`], ['<h2>Local at the core. Precise when it matters.</h2>', `<h2>${c.underTitle}</h2>`],
    ['<p>The friendly story is backed by a deterministic code graph and plain, reviewable records. Hunch can explain its answer—and show the evidence behind it.</p>', `<p>${c.underIntro}</p>`],
    ['<code>code graph</code>', `<code>${c.codeGraph}</code>`], ['<code>MCP + rules</code>', `<code>${c.mcpRules}</code>`], ['<code>conformance</code>', `<code>${c.conformance}</code>`], ['<code>provenance</code>', `<code>${c.provenance}</code>`], ['<code>local-first</code>', `<code>${c.localFirst}</code>`],
    ['<h3>Git-native memory</h3>', `<h3>${c.gitMemoryTitle}</h3>`], ['<p>Keep memory beside the code or connect the whole team to one dedicated private Git repository. Fresh clones discover it from a credential-free pointer.</p>', `<p>${c.gitMemoryBody}</p>`],
    ['<h3>Real blast radius</h3>', `<h3>${c.blastTitle}</h3>`], ['<p>Symbols, callers, components, and dependencies connect the reason to the code it governs.</p>', `<p>${c.blastBody}</p>`],
    ['<h3>Works across assistants</h3>', `<h3>${c.assistantsTitle}</h3>`], ['<p>Claude Code, Cursor, VS Code, Windsurf, Codex, and others read from the same memory.</p>', `<p>${c.assistantsBody}</p>`],
    ['<h3>Deterministic checks</h3>', `<h3>${c.checksTitle}</h3>`], ['<p>Layering, must-reach paths, rejected approaches, and known regressions are checked without an LLM verdict.</p>', `<p>${c.checksBody}</p>`],
    ['<h3>Receipts, not guesses</h3>', `<h3>${c.receiptsTitle}</h3>`], ['<p>Every answer carries its source, confidence, commit, and the history behind the recommendation.</p>', `<p>${c.receiptsBody}</p>`],
    ['<h3>Your memory stays yours</h3>', `<h3>${c.yoursTitle}</h3>`], ['<p>No SaaS is required. Private reasoning can live in a separate overlay you control.</p>', `<p>${c.yoursBody}</p>`],
    ['<p class="tech-link">That is the short version. <a href="/docs">Explore the architecture and full feature set →</a></p>', `<p class="tech-link">${c.shortVersion} <a href="/docs">${c.explore}</a></p>`],
    ['<span class="eyebrow">get started</span>', `<span class="eyebrow">${c.startEyebrow}</span>`], ['<h2>Give your next AI session a memory.</h2>', `<h2>${c.startTitle}</h2>`],
    ['<h3>Install and initialize</h3>', `<h3>${c.installTitle}</h3>`], ['<p>One command indexes the repository, connects supported assistants, and keeps the memory beside your code.</p>', `<p>${c.installBody}</p>`],
    ['<h3>Bring the recent past with you</h3>', `<h3>${c.historyTitle}</h3>`], ['<p><code>hunch backfill --since 90d</code> turns recent history into a useful day-one memory.</p>', `<p>${c.historyBody}</p>`],
    ['<h3>Ask a real question</h3>', `<h3>${c.askTitle}</h3>`], ['<p>Try <em>“why is the session module built this way?”</em> Your assistant answers from the team\'s history, with evidence.</p>', `<p>${c.askBody}</p>`],
    ['aria-label="Supported assistants"', `aria-label="${escAttr(c.supportedAria)}"`],
    ['<span class="c-key"># install from npm — Node 22.13+</span>', `<span class="c-key">${c.installComment}</span>`], ['<span class="c-key"># index + hooks + wire up every assistant</span>', `<span class="c-key">${c.initComment}</span>`],
    ['<span class="c-key"># cold start: seed decisions from history</span>', `<span class="c-key">${c.backfillComment}</span>`], ['<span class="c-key"># the "why" behind any file or symbol</span>', `<span class="c-key">${c.whyComment}</span>`],
    ['<button class="copybtn" data-copy="#install-cmd">copy</button>', `<button class="copybtn" data-copy="#install-cmd">${c.copy}</button>`],
    ['Claude Code? Install as a plugin instead:<br />', `${c.pluginPrompt}<br />`],
    ['<h2>Make your codebase remember why.</h2>', `<h2>${c.ctaTitle}</h2>`], ['<p>Keep the decisions your team already made available to every person and every assistant that comes next.</p>', `<p>${c.ctaBody}</p>`],
    ['<p class="about">Git stores what the code is. Hunch stores why — a persistent, git-native reasoning graph for the age of AI engineering.</p>', `<p class="about">${c.about}</p>`],
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

const source = await readFile(sourcePath, "utf8");
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

  const banned = ["Give AI your", "The bug was fixed", "A team solves", "what changes", "Local at the core", "Install and initialize", "Make your codebase remember why"];
  const visibleHtml = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const phrase of banned) if (visibleHtml.includes(phrase)) throw new Error(`[${locale}] untranslated visible phrase: ${phrase}`);

  const targetDir = path.join(repoRoot, "site", locale);
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, "index.html"), html, "utf8");
  console.log(`generated site/${locale}/index.html (${copy.dir})`);
}

const blogDir = path.join(repoRoot, "site", "blog");
const [blogIndexSource, blogPostSource, postsSource] = await Promise.all([
  readFile(path.join(blogDir, "index.html"), "utf8"),
  readFile(path.join(blogDir, "post.html"), "utf8"),
  readFile(path.join(blogDir, "posts.js"), "utf8"),
]);

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
const changelogSource = await readFile(changelogSourcePath, "utf8");
const changelogRowPattern = /<div class="clog-row"><span class="rel-tag">([^<]+)<\/span><span class="clog-t">([\s\S]*?)<\/span><\/div>/g;
const changelogRowCount = [...changelogSource.matchAll(changelogRowPattern)].length;
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
