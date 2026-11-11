// Homepage translations for site/{he,ar,es,ru}/index.html, consumed by tooling/generate-site-locales.mjs.
//
// Each hunk is an ordered pair of whole lines: `en` must appear in site/index.html (after the
// generator's shared lang/canonical/href rewrites) at or after the previous hunk, and is replaced by
// `tr`. When a hunk only adds lines (a locale-only CSS rule, say), its first line is the unchanged
// English anchor it follows. Editing an English line that a hunk covers makes the generator stop
// with "source fragment not found": update that hunk's `en` and `tr` together, then regenerate.
export const homepageLocales = {
  he: {
    dir: "rtl",
    ogLocale: "he_IL",
    hunks: [
      {
        en: [
          "  <title>Hunch — Shared memory for AI agents</title>",
          "  <meta name=\"description\" content=\"Hunch keeps the why behind your code in Git: decisions, past bugs and the rules that must hold. Every AI coding assistant gets it before it edits, and deterministic checks catch the change that breaks a rule.\" />",
          "  <meta property=\"og:title\" content=\"Hunch — Shared memory for AI agents\" />",
          "  <meta property=\"og:description\" content=\"Your agents forget. Hunch remembers: what you decided, what broke before and which rules must hold. In your Git repo, checked by code.\" />",
        ],
        tr: [
          "  <title>Hunch — זיכרון משותף לסוכני AI</title>",
          "  <meta name=\"description\" content=\"Hunch שומר ב-Git את ה״למה״ שמאחורי הקוד: החלטות, באגים מהעבר והכללים שחייבים להישמר. כל עוזר קוד מבוסס AI מקבל אותו לפני שהוא עורך, ובדיקות דטרמיניסטיות תופסות את השינוי שמפר כלל.\" />",
          "  <meta property=\"og:title\" content=\"Hunch — זיכרון משותף לסוכני AI\" />",
          "  <meta property=\"og:description\" content=\"הסוכנים שלכם שוכחים. Hunch זוכר: מה החלטתם, מה נשבר בעבר ואילו כללים חייבים להישמר. במאגר ה-Git שלכם, בבדיקה של קוד.\" />",
        ],
      },
      {
        en: [
          "  html[lang=\"he\"] .term-bar .replay,html[lang=\"ar\"] .term-bar .replay,html[lang=\"he\"] .new-tag:not(.literal),html[lang=\"ar\"] .new-tag:not(.literal){font-family:var(--sans-local);letter-spacing:0}",
        ],
        tr: [
          "  html[lang=\"he\"] .term-bar .replay,html[lang=\"ar\"] .term-bar .replay,html[lang=\"he\"] .new-tag:not(.literal),html[lang=\"ar\"] .new-tag:not(.literal){font-family:var(--sans-local);letter-spacing:0}",
          "  html[lang=\"he\"] .thesis-tag,html[lang=\"ar\"] .thesis-tag,html[lang=\"he\"] .release-metric strong,html[lang=\"ar\"] .release-metric strong,html[lang=\"he\"] .prov span.local,html[lang=\"ar\"] .prov span.local{font-family:var(--sans-local);letter-spacing:0}",
          "  html[dir=\"rtl\"] .hook-table td{text-align:left}",
        ],
      },
      {
        en: [
          "<a class=\"skip\" href=\"#main\">Skip to content</a>",
          "<a class=\"thesis-band\" href=\"/he/blog/post?slug=the-state-layer\"><span class=\"thesis-tag\">Deterministic State</span><span class=\"thesis-text\">What deterministic state means, in plain words.</span><b class=\"thesis-cta\">Read the thesis →</b></a>",
          "<nav class=\"nav\" aria-label=\"Main\">",
        ],
        tr: [
          "<a class=\"skip\" href=\"#main\">דילוג לתוכן</a>",
          "<a class=\"thesis-band\" href=\"/he/blog/post?slug=the-state-layer\"><span class=\"thesis-tag\">מצב דטרמיניסטי</span><span class=\"thesis-text\">מה זה מצב דטרמיניסטי, במילים פשוטות.</span><b class=\"thesis-cta\">לקריאת התזה ←</b></a>",
          "<nav class=\"nav\" aria-label=\"ניווט ראשי\">",
        ],
      },
      {
        en: [
          "      <a href=\"#how\" class=\"hide-s\">How it works</a>",
          "      <a href=\"#inside\" class=\"hide-s\">Under the hood</a>",
          "      <a href=\"/docs\" class=\"hide-xs\">Docs</a>",
          "      <a href=\"/he/blog\" class=\"hide-xs\">Blog</a>",
          "      <a href=\"/he/changelog\" class=\"hide-s\">Changelog</a>",
        ],
        tr: [
          "      <a href=\"#how\" class=\"hide-s\">כך זה עובד</a>",
          "      <a href=\"#inside\" class=\"hide-s\">מאחורי הקלעים</a>",
          "      <a href=\"/docs\" class=\"hide-xs\">תיעוד</a>",
          "      <a href=\"/he/blog\" class=\"hide-xs\">בלוג</a>",
          "      <a href=\"/he/changelog\" class=\"hide-s\">יומן שינויים</a>",
        ],
      },
      {
        en: [
          "        <span class=\"sr-only\">Language</span>",
          "        <select class=\"lang-select\" id=\"language-switch\" aria-label=\"Language\">",
        ],
        tr: [
          "        <span class=\"sr-only\">שפה</span>",
          "        <select class=\"lang-select\" id=\"language-switch\" aria-label=\"שפה\">",
        ],
      },
      {
        en: [
          "      <a class=\"btn\" href=\"#start\">Get started</a>",
        ],
        tr: [
          "      <a class=\"btn\" href=\"#start\">מתחילים</a>",
        ],
      },
      {
        en: [
          "    <h1 class=\"rise d1\">Your agents forget.<br /><b>Hunch remembers.</b></h1>",
          "    <p class=\"lede rise d2\">Hunch keeps the why behind your code in your Git repo: what you decided, what broke before, which rules must hold. Your assistant gets it before it edits. Then Hunch checks the change — with code, not another model.</p>",
        ],
        tr: [
          "    <h1 class=\"rise d1\">הסוכנים שלכם שוכחים.<br /><b>Hunch זוכר.</b></h1>",
          "    <p class=\"lede rise d2\">Hunch שומר במאגר ה-Git שלכם את ה״למה״ שמאחורי הקוד: מה החלטתם, מה נשבר בעבר, אילו כללים חייבים להישמר. העוזר מקבל את זה לפני שהוא עורך. אחר כך Hunch בודק את השינוי — בקוד, לא במודל נוסף.</p>",
        ],
      },
      {
        en: [
          "      <a class=\"btn\" href=\"#start\">Get started</a>",
          "      <a class=\"btn ghost\" href=\"#story\">See how it works</a>",
        ],
        tr: [
          "      <a class=\"btn\" href=\"#start\">מתחילים</a>",
          "      <a class=\"btn ghost\" href=\"#story\">כך זה עובד</a>",
        ],
      },
      {
        en: [
          "      <span class=\"eyebrow\">the missing context</span>",
          "      <h2>AI reads your code. It wasn’t there when you decided.</h2>",
          "      <p>It sees what the code does. Not why, not what broke last time, not what a tidy-up will break next.</p>",
        ],
        tr: [
          "      <span class=\"eyebrow\">ההקשר החסר</span>",
          "      <h2>AI קורא את הקוד. הוא לא היה שם כשהחלטתם.</h2>",
          "      <p>הוא רואה מה הקוד עושה. לא למה, לא מה נשבר בפעם הקודמת, ולא מה ״סידור קטן״ ישבור בהמשך.</p>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">Monday</span>",
          "          <div><h3>Your team fixes a logout bug.</h3><p>Sign-ins move to the server, so a stolen key dies the moment someone logs out.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">יום שני</span>",
          "          <div><h3>הצוות מתקן באג בהתנתקות.</h3><p>מצב ההתחברות עובר לשרת, כך שמפתח גנוב מפסיק לעבוד ברגע שמתנתקים.</p></div>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">Months later</span>",
          "          <div><h3>The code stays. The reason doesn’t.</h3><p>The discussion is buried. The safe code just looks overcomplicated.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">כעבור חודשים</span>",
          "          <div><h3>הקוד נשאר. הסיבה — לא.</h3><p>הדיון קבור. הקוד הבטוח פשוט נראה מסובך מדי.</p></div>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">Next session</span>",
          "          <div><h3>An AI “cleans it up.”</h3><p>The diff looks great. The logout bug is back.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">בסשן הבא</span>",
          "          <div><h3>AI ״מסדר״ אותו.</h3><p>השינוי נראה מושלם. באג ההתנתקות חזר.</p></div>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">With Hunch</span>",
          "          <div><h3>The reason shows up first.</h3><p>Once the lesson is recorded, Hunch puts the decision, and the bug it prevents, in front of the agent before it edits the file.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">עם Hunch</span>",
          "          <div><h3>הסיבה מגיעה קודם.</h3><p>ברגע שהלקח מתועד, Hunch מציב את ההחלטה, ואת הבאג שהיא מונעת, מול הסוכן לפני שהוא עורך את הקובץ.</p></div>",
        ],
      },
      {
        en: [
          "      <aside class=\"receipt\" aria-label=\"Example project memory\">",
          "        <div class=\"receipt-head\"><span>before editing · <bdi>src/auth/session.ts</bdi></span><b>memory found</b></div>",
        ],
        tr: [
          "      <aside class=\"receipt\" aria-label=\"דוגמה לזיכרון פרויקט\">",
          "        <div class=\"receipt-head\"><span>לפני עריכת · <bdi>src/auth/session.ts</bdi></span><b>נמצא זיכרון</b></div>",
        ],
      },
      {
        en: [
          "          <span class=\"receipt-kicker\">Why this code exists</span>",
          "          <h3>Logging out must end access right away.</h3>",
          "          <div class=\"receipt-row\"><span>chosen</span><p>Keep sign-ins on the server, where they can be ended at once.</p></div>",
          "          <div class=\"receipt-row\"><span>rejected</span><p>Trust a login token until its timer runs out.</p></div>",
          "          <div class=\"receipt-row\"><span>protects</span><p>A stolen token being used after logout.</p></div>",
          "          <p class=\"receipt-foot\">example memory · source attached · advice, not a block</p>",
        ],
        tr: [
          "          <span class=\"receipt-kicker\">למה הקוד הזה קיים</span>",
          "          <h3>התנתקות חייבת להפסיק את הגישה מיד.</h3>",
          "          <div class=\"receipt-row\"><span>נבחר</span><p>לשמור את מצב ההתחברות בשרת, שם אפשר לסיים אותה מיד.</p></div>",
          "          <div class=\"receipt-row\"><span>נדחה</span><p>לסמוך על אסימון התחברות עד שתוקפו יפוג.</p></div>",
          "          <div class=\"receipt-row\"><span>מגן מפני</span><p>שימוש באסימון גנוב אחרי ההתנתקות.</p></div>",
          "          <p class=\"receipt-foot\">זיכרון לדוגמה · המקור מצורף · עצה, לא חסימה</p>",
        ],
      },
      {
        en: [
          "      <button class=\"watch-frame\" type=\"button\" data-yt=\"m2PM6pV7D9Y\" aria-label=\"Play video: Hunch Memory in 2 minutes\">",
        ],
        tr: [
          "      <button class=\"watch-frame\" type=\"button\" data-yt=\"m2PM6pV7D9Y\" aria-label=\"הפעלת סרטון: Hunch Memory בשתי דקות\">",
        ],
      },
      {
        en: [
          "      <figcaption><b>Hunch Memory in 2 minutes.</b> Then the <a href=\"https://www.youtube.com/playlist?list=PLIXqtdE0LcNI\" target=\"_blank\" rel=\"noopener\">7-episode series</a>: setup, hooks, capture, delivery, rules, drift and teams.</figcaption>",
        ],
        tr: [
          "      <figcaption><b>Hunch Memory בשתי דקות</b> (באנגלית). אחר כך, <a href=\"https://www.youtube.com/playlist?list=PLIXqtdE0LcNI\" target=\"_blank\" rel=\"noopener\">הסדרה בת 7 הפרקים</a>: התקנה, hooks, תיעוד, מסירה, כללים, סחיפה וצוותים.</figcaption>",
        ],
      },
      {
        en: [
          "        <span class=\"eyebrow\">why hunch</span>",
          "        <h2>Built to be checked, not trusted.</h2>",
        ],
        tr: [
          "        <span class=\"eyebrow\">למה Hunch</span>",
          "        <h2>בנוי כדי שתבדקו, לא כדי שתסמכו.</h2>",
        ],
      },
      {
        en: [
          "      <p>Six properties you can verify in the public source. <a href=\"/compare\">See how Hunch compares →</a></p>",
        ],
        tr: [
          "      <p>שש תכונות שאפשר לאמת בקוד המקור הציבורי. <a href=\"/compare\">כך Hunch עומד בהשוואה ←</a></p>",
        ],
      },
      {
        en: [
          "      <article class=\"tech-item\"><code>deterministic</code><h3>Rules are checked by code</h3><p>No model call in the blocking path. Same change, same rules, same verdict.</p></article>",
          "      <article class=\"tech-item\"><code>git-native</code><h3>Your memory stays in your repo</h3><p>Plain JSON in <code class=\"literal\">.hunch/</code>. Review it in a PR, revert it, rebuild the index any time. No Hunch account.</p></article>",
          "      <article class=\"tech-item\"><code>receipts</code><h3>Every claim shows its source</h3><p>A block cites the rule it enforces. A task report keeps apart what was delivered, what the agent said and what actually ran.</p></article>",
          "      <article class=\"tech-item\"><code>any assistant</code><h3>One memory, every assistant</h3><p>Claude Code, Codex, Cursor, VS Code/Copilot, Windsurf, Antigravity and other MCP clients. Hook coverage varies by assistant.</p></article>",
          "      <article class=\"tech-item\"><code>no meter</code><h3>No per-token bill</h3><p>Drafting runs on the assistant subscription you already have, or a deterministic local fallback. Metered APIs stay off unless you opt in.</p></article>",
          "      <article class=\"tech-item\"><code>human-gated</code><h3>People decide what’s true</h3><p>Advice by default. Nothing blocks until a person trusts the rule, and an agent can’t change a record a human confirmed.</p></article>",
        ],
        tr: [
          "      <article class=\"tech-item\"><code>דטרמיניסטי</code><h3>כללים נבדקים בקוד</h3><p>אין קריאה למודל במסלול החוסם. אותו שינוי, אותם כללים, אותה הכרעה.</p></article>",
          "      <article class=\"tech-item\"><code>מבוסס Git</code><h3>הזיכרון נשאר במאגר שלכם</h3><p>JSON פשוט בתוך <code class=\"literal\">.hunch/</code>. אפשר לסקור אותו ב-PR, לבטל שינוי ולבנות מחדש את האינדקס בכל עת. בלי חשבון Hunch.</p></article>",
          "      <article class=\"tech-item\"><code>אסמכתאות</code><h3>כל טענה מציגה את המקור שלה</h3><p>חסימה מצטטת את הכלל שהיא אוכפת. דוח משימה מפריד בין מה שנמסר, מה שהסוכן אמר ומה שרץ בפועל.</p></article>",
          "      <article class=\"tech-item\"><code>כל עוזר</code><h3>זיכרון אחד, כל עוזר</h3><p>Claude Code, Codex, Cursor, VS Code/Copilot, Windsurf, Antigravity ולקוחות MCP אחרים. כיסוי ההוקים משתנה מעוזר לעוזר.</p></article>",
          "      <article class=\"tech-item\"><code>בלי מונה</code><h3>בלי חשבון לפי טוקן</h3><p>הניסוח רץ על מנוי העוזר שכבר יש לכם, או על חלופה מקומית דטרמיניסטית. ממשקי API בתשלום לפי שימוש נשארים כבויים, אלא אם בחרתם להפעיל אותם.</p></article>",
          "      <article class=\"tech-item\"><code>באישור אדם</code><h3>בני אדם קובעים מה נכון</h3><p>עצה כברירת מחדל. שום דבר לא נחסם עד שאדם נותן אמון בכלל, וסוכן לא יכול לשנות רשומה שאדם אישר.</p></article>",
        ],
      },
      {
        en: [
          "      <span class=\"eyebrow\">how hunch works</span>",
          "      <h2>Remember. Retrieve. Check.</h2>",
          "      <p>Hunch briefs the agent, then checks its work. The agent still writes the code.</p>",
        ],
        tr: [
          "      <span class=\"eyebrow\">כך Hunch עובד</span>",
          "      <h2>לזכור. לשלוף. לבדוק.</h2>",
          "      <p>Hunch מתדרך את הסוכן, ואז בודק את עבודתו. את הקוד עדיין כותב הסוכן.</p>",
        ],
      },
      {
        en: [
          "      <article class=\"outcome\"><span class=\"step-n\">01 / remember</span><h3>Save what you learned.</h3><p>Decisions, corrections and findings, linked to the code and the source they came from.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">02 / retrieve</span><h3>Bring it back at the right moment.</h3><p>When a task starts, Hunch picks the memory that matters and delivers it through MCP or your assistant’s hooks.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">03 / check</span><h3>Check, then show the receipt.</h3><p>Hunch runs the rules you trust and writes a task report: what it delivered, what the agent used, what passed.</p></article>",
        ],
        tr: [
          "      <article class=\"outcome\"><span class=\"step-n\">01 / לזכור</span><h3>לשמור את מה שלמדנו.</h3><p>החלטות, תיקונים וממצאים, מקושרים לקוד ולמקור שמהם הגיעו.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">02 / לשלוף</span><h3>לשלוף בדיוק ברגע הנכון.</h3><p>כשמשימה מתחילה, Hunch בוחר את הזיכרון הרלוונטי ומוסר אותו דרך MCP או ההוקים של העוזר.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">03 / לבדוק</span><h3>לבדוק, ואז להציג את הדוח.</h3><p>Hunch מריץ את הכללים שנותנים בהם אמון וכותב דוח משימה: מה נמסר, במה הסוכן השתמש ומה עבר.</p></article>",
        ],
      },
      {
        en: [
          "        <h3>Watch a rule hold.</h3>",
          "        <p>An agent reaches for the one thing your team ruled out. The check stops the commit and names the rule.</p>",
        ],
        tr: [
          "        <h3>ראו איך כלל נאכף.</h3>",
          "        <p>סוכן פונה בדיוק לדבר שהצוות שלכם פסל. הבדיקה עוצרת את הקומיט ומציינת את הכלל.</p>",
        ],
      },
      {
        en: [
          "          <li>No model in the blocking path</li>",
          "          <li>Cites the rule, the file and the reason</li>",
          "          <li>Runs before a commit and in CI</li>",
        ],
        tr: [
          "          <li>אין מודל במסלול החוסם</li>",
          "          <li>מצטטת את הכלל, הקובץ והסיבה</li>",
          "          <li>רצה לפני קומיט וב-CI</li>",
        ],
      },
      {
        en: [
          "          <div class=\"term-bar\"><i></i><i></i><i></i>&nbsp; ~/acme-checkout<button class=\"replay\" type=\"button\" hidden>Replay</button></div>",
          "          <pre data-typed><span class=\"tl c-key\"># your team's rule: never import lodash — use src/utils</span>",
          "<span class=\"tl c-key\"># an agent just staged:  + import _ from \"lodash\"</span>",
        ],
        tr: [
          "          <div class=\"term-bar\"><i></i><i></i><i></i>&nbsp; ~/acme-checkout<button class=\"replay\" type=\"button\" hidden>הפעלה חוזרת</button></div>",
          "          <pre data-typed><span class=\"tl c-key\"># הכלל של הצוות: never import lodash — use src/utils</span>",
          "<span class=\"tl c-key\"># סוכן צירף זה עתה לקומיט:  + import _ from \"lodash\"</span>",
        ],
      },
      {
        en: [
          "        <p class=\"demo-note\">Example session; the rule id is illustrative. Run the real one: <a href=\"https://github.com/davesheffer/hunch/blob/main/demo/hunch-blocks-it.sh\">demo/hunch-blocks-it.sh</a></p>",
        ],
        tr: [
          "        <p class=\"demo-note\">סשן לדוגמה; מזהה הכלל להמחשה בלבד. להרצת הגרסה האמיתית: <a href=\"https://github.com/davesheffer/hunch/blob/main/demo/hunch-blocks-it.sh\"><bdi dir=\"ltr\">demo/hunch-blocks-it.sh</bdi></a></p>",
        ],
      },
      {
        en: [
          "          <span class=\"eyebrow\">see the evidence</span>",
          "          <h2 id=\"release-proof-title\">Don’t trust the agent. Read the receipt.</h2>",
          "          <p class=\"release-copy\">Every task report keeps apart three things most tools blur together.</p>",
        ],
        tr: [
          "          <span class=\"eyebrow\">לראות את הראיות</span>",
          "          <h2 id=\"release-proof-title\">לא סומכים על הסוכן. קוראים את הדוח.</h2>",
          "          <p class=\"release-copy\">כל דוח משימה מפריד בין שלושה דברים שרוב הכלים מטשטשים.</p>",
        ],
      },
      {
        en: [
          "      <div class=\"release-metrics\" aria-label=\"What task reports distinguish\">",
          "        <div class=\"release-metric\"><strong>delivered</strong><span>what Hunch handed the agent</span></div>",
          "        <div class=\"release-metric\"><strong>reported</strong><span>what the agent says it used</span></div>",
          "        <div class=\"release-metric\"><strong>checked</strong><span>what rules and commands actually ran</span></div>",
        ],
        tr: [
          "      <div class=\"release-metrics\" aria-label=\"ההבחנות בדוחות משימה\">",
          "        <div class=\"release-metric\"><strong>נמסר</strong><span>מה ש-Hunch מסר לסוכן</span></div>",
          "        <div class=\"release-metric\"><strong>דווח</strong><span>במה הסוכן אומר שהשתמש</span></div>",
          "        <div class=\"release-metric\"><strong>נבדק</strong><span>אילו כללים ופקודות הורצו בפועל</span></div>",
        ],
      },
      {
        en: [
          "      <p class=\"release-caveat\">A green test alone doesn’t prove Hunch helped. No evidence, no claim: it stays unverified. <a href=\"/docs#task-reports\">Read a task report →</a></p>",
        ],
        tr: [
          "      <p class=\"release-caveat\">בדיקה שעברה אינה מוכיחה לבדה ש-Hunch עזר. אין ראיות, אין טענה: התוצאה נשארת לא מאומתת. <a href=\"/docs#task-reports\">לקריאת דוח משימה ←</a></p>",
        ],
      },
      {
        en: [
          "        <span class=\"eyebrow\">new in 1.52</span>",
          "        <h2>What’s new in Hunch.</h2>",
        ],
        tr: [
          "        <span class=\"eyebrow\">חדש ב-1.52</span>",
          "        <h2>מה חדש ב-Hunch.</h2>",
        ],
      },
      {
        en: [
          "      <p>The headlines from the last few releases. The rest is in the <a href=\"/he/changelog\">changelog</a>.</p>",
        ],
        tr: [
          "      <p>עיקרי החידושים מהגרסאות האחרונות. כל השאר ב<a href=\"/he/changelog\">יומן השינויים</a>.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">hunch ui</span><span class=\"new-ver\">1.52</span></div>",
          "        <h3>Your repo’s memory, in your browser.</h3>",
          "        <p>Browse, search, edit, link, remove and restore records in a local web UI. It runs on your machine, and only your click writes memory.</p>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag literal\">hunch ui</span><span class=\"new-ver\">1.52</span></div>",
          "        <h3>הזיכרון של המאגר, בדפדפן שלכם.</h3>",
          "        <p>עיון, חיפוש, עריכה, קישור, הסרה ושחזור של רשומות בממשק ווב מקומי. הוא רץ על המחשב שלכם, ורק לחיצה שלכם כותבת לזיכרון.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">Deliberate · Grill me</span><span class=\"new-ver\">1.52</span></div>",
          "        <h3>A review queue for what needs a person.</h3>",
          "        <p>Deliberate ranks conflicts, stale links, duplicates and weak memory. Grill me questions a record, up to five questions, with secret-looking files withheld.</p>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag literal\">Deliberate · Grill me</span><span class=\"new-ver\">1.52</span></div>",
          "        <h3>תור סקירה למה שדורש אדם.</h3>",
          "        <p>Deliberate מדרג סתירות, קישורים שהתיישנו, כפילויות וזיכרון חלש. Grill me מתשאל רשומה, עד חמש שאלות, כשקבצים שנראים כמו סודות נשארים חסויים.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">Elixir</span><span class=\"new-ver\">1.52</span></div>",
          "        <h3>Elixir joins the graph.</h3>",
          "        <p>Blast radius, dependents and rule checks now work on Elixir, next to TypeScript, JavaScript, Python, Go and PHP. Static analysis, no LLM.</p>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag literal\">Elixir</span><span class=\"new-ver\">1.52</span></div>",
          "        <h3>Elixir מצטרפת לגרף.</h3>",
          "        <p>טווח השפעה, קוד תלוי ובדיקות כללים עובדים עכשיו גם ב-Elixir, לצד TypeScript, JavaScript, Python, Go ו-PHP. ניתוח סטטי, בלי LLM.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">hunch derive-rules</span><span class=\"new-ver\">1.49</span></div>",
          "        <h3>Write the rule in your docs. Hunch enforces it.</h3>",
          "        <p>Mark a sentence with <code>&lt;!-- hunch:rule scope=… --&gt;</code> and it becomes a constraint. <code>--check</code> fails CI when doc and graph disagree.</p>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag literal\">hunch derive-rules</span><span class=\"new-ver\">1.49</span></div>",
          "        <h3>כתבו את הכלל בתיעוד. Hunch יאכוף אותו.</h3>",
          "        <p>סמנו משפט ב-<code>&lt;!-- hunch:rule scope=… --&gt;</code> והוא הופך לאילוץ. <code>--check</code> מכשיל את ה-CI כשהתיעוד והגרף לא תואמים.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">hunch verify</span><span class=\"new-ver\">1.46</span></div>",
          "        <h3>Run only the tests a change needs.</h3>",
          "        <p>Hunch picks the tests that import or ran the changed code. Doubt means more tests: a change it can’t trace runs the full suite.</p>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag literal\">hunch verify</span><span class=\"new-ver\">1.46</span></div>",
          "        <h3>להריץ רק את הבדיקות שהשינוי צריך.</h3>",
          "        <p>Hunch בוחר את הבדיקות שמייבאות את הקוד שהשתנה או שהריצו אותו. ספק פירושו יותר בדיקות: שינוי שאי אפשר לעקוב אחריו מריץ את הסוויטה המלאה.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">hooks</span><span class=\"new-ver\">1.51</span></div>",
          "        <h3>Hooks that stay out of your way.</h3>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag\">הוקים</span><span class=\"new-ver\">1.51</span></div>",
          "        <h3>הוקים שלא מפריעים לעבוד.</h3>",
        ],
      },
      {
        en: [
          "          <caption class=\"sr-only\">Median hook time before and after 1.51.0, in milliseconds</caption>",
        ],
        tr: [
          "          <caption class=\"sr-only\">זמן הוק חציוני לפני ואחרי 1.51.0, במילישניות</caption>",
        ],
      },
      {
        en: [
          "            <tr><th scope=\"row\">When a task stops</th><td>2174 → <b>298 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Before an edit</th><td>500 → <b>334 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Per prompt</th><td>299 → <b>213 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Session start</th><td>251 → <b>148 ms</b></td></tr>",
        ],
        tr: [
          "            <tr><th scope=\"row\">כשמשימה נעצרת</th><td>2174 → <b>298 ms</b></td></tr>",
          "            <tr><th scope=\"row\">לפני עריכה</th><td>500 → <b>334 ms</b></td></tr>",
          "            <tr><th scope=\"row\">בכל פרומפט</th><td>299 → <b>213 ms</b></td></tr>",
          "            <tr><th scope=\"row\">תחילת סשן</th><td>251 → <b>148 ms</b></td></tr>",
        ],
      },
      {
        en: [
          "        <p class=\"new-cap\">Median hook time on the benchmark VM, before and after 1.51.0. Hook output is identical.</p>",
        ],
        tr: [
          "        <p class=\"new-cap\">זמן הוק חציוני ב-VM של מדד הביצועים, לפני ואחרי 1.51.0. פלט ההוקים זהה.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">memory home</span><span class=\"new-ver\">1.51</span></div>",
          "        <h3>One memory per repository.</h3>",
          "        <p>Worktrees and extra clones of a repo share one memory home, chosen from the repo’s identity, not the folder you’re in.</p>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag\">בית הזיכרון</span><span class=\"new-ver\">1.51</span></div>",
          "        <h3>זיכרון אחד לכל מאגר.</h3>",
          "        <p>Worktrees ושכפולים נוספים של אותו מאגר חולקים בית זיכרון אחד, שנבחר לפי זהות המאגר ולא לפי התיקייה שבה אתם נמצאים.</p>",
        ],
      },
      {
        en: [
          "      <summary>Also new since 1.44</summary>",
        ],
        tr: [
          "      <summary>עוד חידושים מאז 1.44</summary>",
        ],
      },
      {
        en: [
          "        <li><span>1.51</span><div><code>hunch log --for &lt;commit&gt;</code> shows which memory led to which feature commit.</div></li>",
          "        <li><span>1.51</span><div><code>hunch mcp</code> answers the handshake in 1.7–3.7 s. With a large overlay on Windows it used to take 28–76 s.</div></li>",
          "        <li><span>1.50</span><div>A correction can retire the rule it reverses. Nothing is deleted.</div></li>",
          "        <li><span>1.50</span><div>When a test run fails, the hook names the past bug it matches.</div></li>",
          "        <li><span>1.48</span><div>Licensed FSL-1.1-ALv2. Each release converts to Apache-2.0 two years after it ships.</div></li>",
          "        <li><span>1.45</span><div><code>hunch init</code> configures only the assistants it finds.</div></li>",
          "        <li><span>1.44</span><div><code>hunch uninstall</code> removes what Hunch installed and keeps your memory.</div></li>",
          "        <li><span>1.44</span><div>Agent writes over MCP can’t change a record a human confirmed.</div></li>",
        ],
        tr: [
          "        <li><span>1.51</span><div><code>hunch log --for &lt;commit&gt;</code> מראה איזה זיכרון הוביל לאיזה קומיט של פיצ׳ר.</div></li>",
          "        <li><span>1.51</span><div><code>hunch mcp</code> עונה ל-handshake בתוך <bdi dir=\"ltr\">1.7–3.7 s</bdi>. עם overlay גדול ב-Windows זה לקח בעבר <bdi dir=\"ltr\">28–76 s</bdi>.</div></li>",
          "        <li><span>1.50</span><div>תיקון יכול להוציא משימוש את הכלל שהוא הופך. שום דבר לא נמחק.</div></li>",
          "        <li><span>1.50</span><div>כשהרצת בדיקות נכשלת, ההוק מציין את הבאג מהעבר שהיא תואמת.</div></li>",
          "        <li><span>1.48</span><div>ברישיון <bdi dir=\"ltr\">FSL-1.1-ALv2</bdi>. כל גרסה עוברת ל-<bdi dir=\"ltr\">Apache-2.0</bdi> שנתיים אחרי שחרורה.</div></li>",
          "        <li><span>1.45</span><div><code>hunch init</code> מגדיר רק את העוזרים שהוא מוצא.</div></li>",
          "        <li><span>1.44</span><div><code>hunch uninstall</code> מסיר את מה ש-Hunch התקין ושומר על הזיכרון שלכם.</div></li>",
          "        <li><span>1.44</span><div>כתיבות של סוכנים דרך MCP לא יכולות לשנות רשומה שאדם אישר.</div></li>",
        ],
      },
      {
        en: [
          "        <span class=\"eyebrow\">under the hood</span>",
          "        <h2>Know what a change breaks before you make it.</h2>",
        ],
        tr: [
          "        <span class=\"eyebrow\">מאחורי הקלעים</span>",
          "        <h2>לדעת מה שינוי ישבור לפני שמבצעים אותו.</h2>",
        ],
      },
      {
        en: [
          "      <p>Hunch ties each reason to the code’s real dependencies and to the rules your team chose to protect.</p>",
        ],
        tr: [
          "      <p>Hunch קושר כל סיבה לתלויות האמיתיות של הקוד ולכללים שהצוות בחר להגן עליהם.</p>",
        ],
      },
      {
        en: [
          "      <article class=\"tech-item\"><code class=\"literal\">hunch why</code><h3>Find the reason</h3><p>The decisions, rejected ideas and past bugs behind any file or symbol.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch impact</code><h3>See what depends on it</h3><p>Follow the code’s real connections to everything a change can reach.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch check</code><h3>Guard the rules you trust</h3><p>Flags a change that breaks a trusted rule. Strict mode blocks only where that rule and your assistant allow it.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch conform</code><h3>Check the code keeps its promises</h3><p>For example: does the payment path still check authorization?</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch drift</code><h3>Catch docs that fell behind</h3><p>A doc still pinned to a replaced decision fails <code class=\"literal\">hunch drift</code>, so CI can catch it.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch dna inspect</code><h3>Learn the house style</h3><p>The terms and habits Hunch observed in this repo. Advice only.</p></article>",
        ],
        tr: [
          "      <article class=\"tech-item\"><code class=\"literal\">hunch why</code><h3>למצוא את הסיבה</h3><p>ההחלטות, הרעיונות שנדחו והבאגים מהעבר שמאחורי כל קובץ או סימבול.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch impact</code><h3>לראות מה תלוי בו</h3><p>עוקבים אחרי הקשרים האמיתיים של הקוד אל כל מה ששינוי יכול להגיע אליו.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch check</code><h3>להגן על כללים שסומכים עליהם</h3><p>מסמן שינוי שמפר כלל מהימן. מצב strict חוסם רק כשהכלל והעוזר שלכם מאפשרים זאת.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch conform</code><h3>לוודא שהקוד עומד בהבטחותיו</h3><p>למשל: האם מסלול התשלום עדיין בודק הרשאה?</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch drift</code><h3>לתפוס תיעוד שנשאר מאחור</h3><p>מסמך שעדיין מוצמד להחלטה שהוחלפה מכשיל את <code class=\"literal\">hunch drift</code>, כך שה-CI יכול לתפוס אותו.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch dna inspect</code><h3>להכיר את סגנון הבית</h3><p>המינוח וההרגלים ש-Hunch זיהה במאגר הזה. בגדר עצה בלבד.</p></article>",
        ],
      },
      {
        en: [
          "    <p class=\"tech-link\">Indexes TypeScript, JavaScript, Python, Go, PHP and Elixir, plus Helm, Kustomize and YAML. Beyond code, <code>hunch serve</code> is a self-hosted service that <a href=\"/docs#shared-state\">shares decisions, finished work and open commitments</a> across agents. <a href=\"/docs\">Read the docs →</a></p>",
        ],
        tr: [
          "    <p class=\"tech-link\">מאנדקס TypeScript, JavaScript, Python, Go, PHP ו-Elixir, וגם Helm, Kustomize ו-YAML. מעבר לקוד, <code>hunch serve</code> הוא שירות באירוח עצמי ש<a href=\"/docs#shared-state\">משתף החלטות, עבודה שהושלמה והתחייבויות פתוחות</a> בין סוכנים. <a href=\"/docs\">קריאת התיעוד ←</a></p>",
        ],
      },
      {
        en: [
          "      <span class=\"eyebrow\">get started</span>",
          "      <h2>Start in one repository.</h2>",
          "      <p>Needs Node 22.13+ and a Git repository. No Hunch account.</p>",
        ],
        tr: [
          "      <span class=\"eyebrow\">מתחילים</span>",
          "      <h2>מתחילים במאגר אחד.</h2>",
          "      <p>נדרשים <bdi dir=\"ltr\">Node 22.13+</bdi> ומאגר Git. בלי חשבון Hunch.</p>",
        ],
      },
      {
        en: [
          "          <div class=\"step\"><span class=\"step-n\">01</span><div><h3>Install and connect</h3><p>Install the CLI, then run <code>hunch init</code> in your project. It sets up only the assistants you have.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">02</span><div><h3>Teach it your history</h3><p>Optional: draft memory from the last 90 days of Git, then review what it captured.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">03</span><div><h3>Ask why</h3><p>Reload your assistant and ask why a file is built this way. Using Codex? Trust the hooks in <code>/hooks</code> first.</p></div></div>",
        ],
        tr: [
          "          <div class=\"step\"><span class=\"step-n\">01</span><div><h3>התקנה וחיבור</h3><p>מתקינים את ה-CLI ומריצים <code>hunch init</code> בפרויקט. הוא מגדיר רק את העוזרים שיש לכם.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">02</span><div><h3>ללמד אותו את ההיסטוריה שלכם</h3><p>אופציונלי: לנסח זיכרון מ-90 הימים האחרונים ב-Git, ואז לסקור מה נלכד.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">03</span><div><h3>לשאול למה</h3><p>טוענים מחדש את העוזר ושואלים למה קובץ בנוי כך. ב-Codex יש לאשר קודם את ההוקים ב-<code>/hooks</code>.</p></div></div>",
        ],
      },
      {
        en: [
          "        <div class=\"prov\" role=\"group\" aria-label=\"Supported assistants\">",
          "          <span>Claude Code</span><span>Codex</span><span>Cursor</span><span>VS Code / Copilot</span><span>Windsurf</span><span>Antigravity</span><span>any MCP client</span>",
        ],
        tr: [
          "        <div class=\"prov\" role=\"group\" aria-label=\"עוזרים נתמכים\">",
          "          <span>Claude Code</span><span>Codex</span><span>Cursor</span><span>VS Code / Copilot</span><span>Windsurf</span><span>Antigravity</span><span class=\"local\">כל לקוח MCP</span>",
        ],
      },
      {
        en: [
          "          <pre style=\"min-height:0\"><span class=\"c-key\"># install from npm</span>",
        ],
        tr: [
          "          <pre style=\"min-height:0\"><span class=\"c-key\"># התקנה מ-npm</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># connect Hunch to this project</span>",
        ],
        tr: [
          "<span class=\"c-key\"># חיבור Hunch לפרויקט</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># learn from the last 90 days</span>",
        ],
        tr: [
          "<span class=\"c-key\"># ללמוד מ-90 הימים האחרונים</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># ask what a file is for</span>",
        ],
        tr: [
          "<span class=\"c-key\"># לשאול בשביל מה קובץ קיים</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># browse your memory in the browser</span>",
        ],
        tr: [
          "<span class=\"c-key\"># לעיין בזיכרון בדפדפן</span>",
        ],
      },
      {
        en: [
          "          <button class=\"copybtn\" type=\"button\" data-clip=\"#install-cmd\" data-clip-done=\"Copied\"><svg class=\"clip-ico\" viewBox=\"0 0 16 16\" aria-hidden=\"true\" focusable=\"false\"><g class=\"ico-copy\"><rect x=\"5.5\" y=\"5.5\" width=\"8\" height=\"8\" rx=\"1.6\"/><path d=\"M10.5 3.5v-.4a1.6 1.6 0 0 0-1.6-1.6H3.1a1.6 1.6 0 0 0-1.6 1.6v5.8a1.6 1.6 0 0 0 1.6 1.6h.4\"/></g><path class=\"ico-check\" d=\"M3 8.6l3.2 3.2L13 4.9\"/></svg><span class=\"clip-label\">Copy</span></button>",
        ],
        tr: [
          "          <button class=\"copybtn\" type=\"button\" data-clip=\"#install-cmd\" data-clip-done=\"הועתק\"><svg class=\"clip-ico\" viewBox=\"0 0 16 16\" aria-hidden=\"true\" focusable=\"false\"><g class=\"ico-copy\"><rect x=\"5.5\" y=\"5.5\" width=\"8\" height=\"8\" rx=\"1.6\"/><path d=\"M10.5 3.5v-.4a1.6 1.6 0 0 0-1.6-1.6H3.1a1.6 1.6 0 0 0-1.6 1.6v5.8a1.6 1.6 0 0 0 1.6 1.6h.4\"/></g><path class=\"ico-check\" d=\"M3 8.6l3.2 3.2L13 4.9\"/></svg><span class=\"clip-label\">העתקה</span></button>",
        ],
      },
      {
        en: [
          "          <li>Advice by default. Nothing blocks until you say so.</li>",
          "          <li>Update with <code>hunch update</code>. Leave with <code>hunch uninstall</code>: it removes what Hunch installed and keeps your memory.</li>",
          "          <li>Claude Code? Install as a plugin: <code>/plugin marketplace add davesheffer/hunch</code> → <code>/plugin install hunch@hunch</code></li>",
          "          <li>VS Code? <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">Get the extension on Open VSX</a></li>",
        ],
        tr: [
          "          <li>עצה כברירת מחדל. שום דבר לא נחסם עד שמחליטים אחרת.</li>",
          "          <li>מעדכנים עם <code>hunch update</code>. עוזבים עם <code>hunch uninstall</code>: הוא מסיר את מה ש-Hunch התקין ושומר על הזיכרון שלכם.</li>",
          "          <li>משתמשים ב-Claude Code? התקינו כתוסף: <code>/plugin marketplace add davesheffer/hunch</code> ← <code>/plugin install hunch@hunch</code></li>",
          "          <li>VS Code? <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">התוסף זמין ב-Open VSX</a></li>",
        ],
      },
      {
        en: [
          "    <h2>Stop re-explaining your codebase.</h2>",
          "    <p>Give every agent the same memory and every change the same check. It advises by default, and one command removes it.</p>",
        ],
        tr: [
          "    <h2>מספיק להסביר את הקוד שלכם שוב ושוב.</h2>",
          "    <p>תנו לכל סוכן את אותו זיכרון ולכל שינוי את אותה בדיקה. Hunch מייעץ כברירת מחדל, ופקודה אחת מסירה אותו.</p>",
        ],
      },
      {
        en: [
          "      <a class=\"btn\" href=\"#start\">Get started</a>",
          "      <a class=\"btn ghost\" href=\"/docs\">Read the docs</a>",
        ],
        tr: [
          "      <a class=\"btn\" href=\"#start\">מתחילים</a>",
          "      <a class=\"btn ghost\" href=\"/docs\">קריאת התיעוד</a>",
        ],
      },
      {
        en: [
          "      <p class=\"about\">Hunch keeps the why behind your code, in Git, for every assistant you use.</p>",
          "      <p class=\"about\">FSL-1.1-ALv2. Use it for your own work, internal or commercial. Each release becomes Apache-2.0 two years after it ships.</p>",
        ],
        tr: [
          "      <p class=\"about\">Hunch שומר את ה״למה״ שמאחורי הקוד, ב-Git, לכל עוזר שאתם משתמשים בו.</p>",
          "      <p class=\"about\"><bdi dir=\"ltr\">FSL-1.1-ALv2</bdi>. מותר לשימוש בעבודה שלכם, פנימית או מסחרית. כל גרסה הופכת ל-<bdi dir=\"ltr\">Apache-2.0</bdi> שנתיים אחרי שחרורה.</p>",
        ],
      },
      {
        en: [
          "      <h4>product</h4>",
          "      <a href=\"#how\">How it works</a>",
          "      <a href=\"#new\">What’s new</a>",
          "      <a href=\"#inside\">Under the hood</a>",
          "      <a href=\"/compare\">Compare</a>",
          "      <a href=\"/he/changelog\">Changelog</a>",
        ],
        tr: [
          "      <h4>מוצר</h4>",
          "      <a href=\"#how\">כך זה עובד</a>",
          "      <a href=\"#new\">מה חדש</a>",
          "      <a href=\"#inside\">מאחורי הקלעים</a>",
          "      <a href=\"/compare\">השוואה</a>",
          "      <a href=\"/he/changelog\">יומן שינויים</a>",
        ],
      },
      {
        en: [
          "      <h4>develop</h4>",
          "      <a href=\"#start\">Get started</a>",
          "      <a href=\"/docs\">Docs</a>",
          "      <a href=\"/docs#mcp\">MCP tools</a>",
          "      <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">VS Code extension</a>",
        ],
        tr: [
          "      <h4>פיתוח</h4>",
          "      <a href=\"#start\">מתחילים</a>",
          "      <a href=\"/docs\">תיעוד</a>",
          "      <a href=\"/docs#mcp\">כלי MCP</a>",
          "      <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">תוסף ל-VS Code</a>",
        ],
      },
      {
        en: [
          "      <h4>connect</h4>",
        ],
        tr: [
          "      <h4>קישורים</h4>",
        ],
      },
      {
        en: [
          "      <a href=\"/he/blog\">Blog</a>",
        ],
        tr: [
          "      <a href=\"/he/blog\">בלוג</a>",
        ],
      },
      {
        en: [
          "    const RECEIPTS = [\"dec_8b2e · held\", \"dec_a466 · held\", \"dec_e0a3 · held\", \"dec_fd36 · held\"];",
          "    const BLOCKS = [\"con_9027 · blocked\", \"con_2ce3 · blocked\"];",
        ],
        tr: [
          "    const RECEIPTS = [\"dec_8b2e · נשמר\", \"dec_a466 · נשמר\", \"dec_e0a3 · נשמר\", \"dec_fd36 · נשמר\"];",
          "    const BLOCKS = [\"con_9027 · נחסם\", \"con_2ce3 · נחסם\"];",
        ],
      },
      {
        en: [
          "      { label: \"decision\", angle: -2.55 },",
          "      { label: \"bug\", angle: -0.18 },",
          "      { label: \"rule\", angle: 1.72 },",
        ],
        tr: [
          "      { label: \"החלטה\", angle: -2.55 },",
          "      { label: \"באג\", angle: -0.18 },",
          "      { label: \"כלל\", angle: 1.72 },",
        ],
      },
      {
        en: [
          "      ctx.fillText(\"why\", x, y + 0.5);",
        ],
        tr: [
          "      ctx.fillText(\"למה\", x, y + 0.5);",
        ],
      },
      {
        en: [
          "        ctx.fillText(\"reason recalled before edit\", x, y + r + 34);",
        ],
        tr: [
          "        ctx.fillText(\"הסיבה נשלפה לפני העריכה\", x, y + r + 34);",
        ],
      },
    ],
  },
  ar: {
    dir: "rtl",
    ogLocale: "ar",
    hunks: [
      {
        en: [
          "  <title>Hunch — Shared memory for AI agents</title>",
          "  <meta name=\"description\" content=\"Hunch keeps the why behind your code in Git: decisions, past bugs and the rules that must hold. Every AI coding assistant gets it before it edits, and deterministic checks catch the change that breaks a rule.\" />",
          "  <meta property=\"og:title\" content=\"Hunch — Shared memory for AI agents\" />",
          "  <meta property=\"og:description\" content=\"Your agents forget. Hunch remembers: what you decided, what broke before and which rules must hold. In your Git repo, checked by code.\" />",
        ],
        tr: [
          "  <title>Hunch — ذاكرة مشتركة لوكلاء الذكاء الاصطناعي</title>",
          "  <meta name=\"description\" content=\"يحفظ Hunch «لماذا» وراء شيفرتك في Git: القرارات، والأخطاء السابقة، والقواعد التي يجب أن تبقى سارية. يحصل عليها كل مساعد برمجة بالذكاء الاصطناعي قبل أن يعدّل، وفحوص حتمية تلتقط التغيير الذي يخالف قاعدة.\" />",
          "  <meta property=\"og:title\" content=\"Hunch — ذاكرة مشتركة لوكلاء الذكاء الاصطناعي\" />",
          "  <meta property=\"og:description\" content=\"وكلاؤك ينسون. Hunch يتذكّر: ما قرّرتَه، وما انكسر من قبل، وأي القواعد يجب أن تبقى سارية. في مستودع Git لديك، ويُفحص بالشيفرة.\" />",
        ],
      },
      {
        en: [
          "  html[lang=\"he\"] .term-bar .replay,html[lang=\"ar\"] .term-bar .replay,html[lang=\"he\"] .new-tag:not(.literal),html[lang=\"ar\"] .new-tag:not(.literal){font-family:var(--sans-local);letter-spacing:0}",
        ],
        tr: [
          "  html[lang=\"he\"] .term-bar .replay,html[lang=\"ar\"] .term-bar .replay,html[lang=\"he\"] .new-tag:not(.literal),html[lang=\"ar\"] .new-tag:not(.literal){font-family:var(--sans-local);letter-spacing:0}",
          "  html[lang=\"he\"] .thesis-tag,html[lang=\"ar\"] .thesis-tag,html[lang=\"he\"] .release-metric strong,html[lang=\"ar\"] .release-metric strong,html[lang=\"he\"] .prov span.local,html[lang=\"ar\"] .prov span.local{font-family:var(--sans-local);letter-spacing:0}",
          "  html[dir=\"rtl\"] .hook-table td{text-align:left}",
        ],
      },
      {
        en: [
          "<a class=\"skip\" href=\"#main\">Skip to content</a>",
          "<a class=\"thesis-band\" href=\"/ar/blog/post?slug=the-state-layer\"><span class=\"thesis-tag\">Deterministic State</span><span class=\"thesis-text\">What deterministic state means, in plain words.</span><b class=\"thesis-cta\">Read the thesis →</b></a>",
          "<nav class=\"nav\" aria-label=\"Main\">",
        ],
        tr: [
          "<a class=\"skip\" href=\"#main\">انتقل إلى المحتوى</a>",
          "<a class=\"thesis-band\" href=\"/ar/blog/post?slug=the-state-layer\"><span class=\"thesis-tag\">الحالة الحتمية</span><span class=\"thesis-text\">ما معنى الحالة الحتمية، بكلمات بسيطة.</span><b class=\"thesis-cta\">اقرأ الأطروحة ←</b></a>",
          "<nav class=\"nav\" aria-label=\"التنقّل الرئيسي\">",
        ],
      },
      {
        en: [
          "      <a href=\"#how\" class=\"hide-s\">How it works</a>",
          "      <a href=\"#inside\" class=\"hide-s\">Under the hood</a>",
          "      <a href=\"/docs\" class=\"hide-xs\">Docs</a>",
          "      <a href=\"/ar/blog\" class=\"hide-xs\">Blog</a>",
          "      <a href=\"/ar/changelog\" class=\"hide-s\">Changelog</a>",
        ],
        tr: [
          "      <a href=\"#how\" class=\"hide-s\">كيف يعمل</a>",
          "      <a href=\"#inside\" class=\"hide-s\">ما وراء الواجهة</a>",
          "      <a href=\"/docs\" class=\"hide-xs\">الوثائق</a>",
          "      <a href=\"/ar/blog\" class=\"hide-xs\">المدوّنة</a>",
          "      <a href=\"/ar/changelog\" class=\"hide-s\">سجل التغييرات</a>",
        ],
      },
      {
        en: [
          "        <span class=\"sr-only\">Language</span>",
          "        <select class=\"lang-select\" id=\"language-switch\" aria-label=\"Language\">",
        ],
        tr: [
          "        <span class=\"sr-only\">اللغة</span>",
          "        <select class=\"lang-select\" id=\"language-switch\" aria-label=\"اللغة\">",
        ],
      },
      {
        en: [
          "      <a class=\"btn\" href=\"#start\">Get started</a>",
        ],
        tr: [
          "      <a class=\"btn\" href=\"#start\">ابدأ الآن</a>",
        ],
      },
      {
        en: [
          "    <h1 class=\"rise d1\">Your agents forget.<br /><b>Hunch remembers.</b></h1>",
          "    <p class=\"lede rise d2\">Hunch keeps the why behind your code in your Git repo: what you decided, what broke before, which rules must hold. Your assistant gets it before it edits. Then Hunch checks the change — with code, not another model.</p>",
        ],
        tr: [
          "    <h1 class=\"rise d1\">وكلاؤك ينسون.<br /><b>Hunch يتذكّر.</b></h1>",
          "    <p class=\"lede rise d2\">يحفظ Hunch «لماذا» وراء شيفرتك في مستودع Git لديك: ما قرّرتَه، وما انكسر من قبل، وأي القواعد يجب أن تبقى سارية. يحصل عليها مساعدك قبل أن يعدّل. ثم يفحص Hunch التغيير — بالشيفرة، لا بنموذج آخر.</p>",
        ],
      },
      {
        en: [
          "      <a class=\"btn\" href=\"#start\">Get started</a>",
          "      <a class=\"btn ghost\" href=\"#story\">See how it works</a>",
        ],
        tr: [
          "      <a class=\"btn\" href=\"#start\">ابدأ الآن</a>",
          "      <a class=\"btn ghost\" href=\"#story\">شاهد كيف يعمل</a>",
        ],
      },
      {
        en: [
          "      <span class=\"eyebrow\">the missing context</span>",
          "      <h2>AI reads your code. It wasn’t there when you decided.</h2>",
          "      <p>It sees what the code does. Not why, not what broke last time, not what a tidy-up will break next.</p>",
        ],
        tr: [
          "      <span class=\"eyebrow\">السياق المفقود</span>",
          "      <h2>الذكاء الاصطناعي يقرأ شيفرتك. لكنه لم يكن حاضرًا حين اتُّخذ القرار.</h2>",
          "      <p>يرى ما تفعله الشيفرة. لا لماذا، ولا ما انكسر في المرة السابقة، ولا ما سيكسره «ترتيب بسيط» لاحقًا.</p>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">Monday</span>",
          "          <div><h3>Your team fixes a logout bug.</h3><p>Sign-ins move to the server, so a stolen key dies the moment someone logs out.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">يوم الاثنين</span>",
          "          <div><h3>يصلح الفريق خطأً في تسجيل الخروج.</h3><p>ينتقل تسجيل الدخول إلى الخادم، فيتوقف المفتاح المسروق عن العمل لحظة تسجيل الخروج.</p></div>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">Months later</span>",
          "          <div><h3>The code stays. The reason doesn’t.</h3><p>The discussion is buried. The safe code just looks overcomplicated.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">بعد أشهر</span>",
          "          <div><h3>تبقى الشيفرة. ويضيع السبب.</h3><p>النقاش مدفون. والشيفرة الآمنة تبدو ببساطة معقّدة بلا داعٍ.</p></div>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">Next session</span>",
          "          <div><h3>An AI “cleans it up.”</h3><p>The diff looks great. The logout bug is back.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">الجلسة التالية</span>",
          "          <div><h3>ذكاء اصطناعي «ينظّف» الشيفرة.</h3><p>التغيير يبدو رائعًا. وخطأ تسجيل الخروج يعود.</p></div>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">With Hunch</span>",
          "          <div><h3>The reason shows up first.</h3><p>Once the lesson is recorded, Hunch puts the decision, and the bug it prevents, in front of the agent before it edits the file.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">مع Hunch</span>",
          "          <div><h3>السبب يصل أولًا.</h3><p>متى سُجّل الدرس، يضع Hunch القرار، والخطأ الذي يمنعه، أمام الوكيل قبل أن يعدّل الملف.</p></div>",
        ],
      },
      {
        en: [
          "      <aside class=\"receipt\" aria-label=\"Example project memory\">",
          "        <div class=\"receipt-head\"><span>before editing · <bdi>src/auth/session.ts</bdi></span><b>memory found</b></div>",
        ],
        tr: [
          "      <aside class=\"receipt\" aria-label=\"مثال على ذاكرة المشروع\">",
          "        <div class=\"receipt-head\"><span>قبل تعديل · <bdi>src/auth/session.ts</bdi></span><b>عُثر على ذاكرة</b></div>",
        ],
      },
      {
        en: [
          "          <span class=\"receipt-kicker\">Why this code exists</span>",
          "          <h3>Logging out must end access right away.</h3>",
          "          <div class=\"receipt-row\"><span>chosen</span><p>Keep sign-ins on the server, where they can be ended at once.</p></div>",
          "          <div class=\"receipt-row\"><span>rejected</span><p>Trust a login token until its timer runs out.</p></div>",
          "          <div class=\"receipt-row\"><span>protects</span><p>A stolen token being used after logout.</p></div>",
          "          <p class=\"receipt-foot\">example memory · source attached · advice, not a block</p>",
        ],
        tr: [
          "          <span class=\"receipt-kicker\">لماذا توجد هذه الشيفرة</span>",
          "          <h3>يجب أن ينهي تسجيل الخروج الوصول فورًا.</h3>",
          "          <div class=\"receipt-row\"><span>المختار</span><p>الاحتفاظ بحالة تسجيل الدخول على الخادم، حيث يمكن إنهاؤها فورًا.</p></div>",
          "          <div class=\"receipt-row\"><span>المرفوض</span><p>الثقة برمز تسجيل الدخول حتى تنتهي صلاحيته.</p></div>",
          "          <div class=\"receipt-row\"><span>يحمي من</span><p>استخدام رمز مسروق بعد تسجيل الخروج.</p></div>",
          "          <p class=\"receipt-foot\">ذاكرة توضيحية · المصدر مرفق · إرشاد لا حظر</p>",
        ],
      },
      {
        en: [
          "      <button class=\"watch-frame\" type=\"button\" data-yt=\"m2PM6pV7D9Y\" aria-label=\"Play video: Hunch Memory in 2 minutes\">",
        ],
        tr: [
          "      <button class=\"watch-frame\" type=\"button\" data-yt=\"m2PM6pV7D9Y\" aria-label=\"تشغيل الفيديو: Hunch Memory في دقيقتين\">",
        ],
      },
      {
        en: [
          "      <figcaption><b>Hunch Memory in 2 minutes.</b> Then the <a href=\"https://www.youtube.com/playlist?list=PLIXqtdE0LcNI\" target=\"_blank\" rel=\"noopener\">7-episode series</a>: setup, hooks, capture, delivery, rules, drift and teams.</figcaption>",
        ],
        tr: [
          "      <figcaption><b>Hunch Memory في دقيقتين</b> (بالإنجليزية). ثم <a href=\"https://www.youtube.com/playlist?list=PLIXqtdE0LcNI\" target=\"_blank\" rel=\"noopener\">سلسلة من 7 حلقات</a>: الإعداد، والخطافات، والتسجيل، والتسليم، والقواعد، والانحراف، والفرق.</figcaption>",
        ],
      },
      {
        en: [
          "        <span class=\"eyebrow\">why hunch</span>",
          "        <h2>Built to be checked, not trusted.</h2>",
        ],
        tr: [
          "        <span class=\"eyebrow\">لماذا Hunch</span>",
          "        <h2>مبنيّ ليُفحَص، لا ليُصدَّق.</h2>",
        ],
      },
      {
        en: [
          "      <p>Six properties you can verify in the public source. <a href=\"/compare\">See how Hunch compares →</a></p>",
        ],
        tr: [
          "      <p>ست خصائص يمكنك التحقق منها في المصدر العلني. <a href=\"/compare\">شاهد مقارنة Hunch ←</a></p>",
        ],
      },
      {
        en: [
          "      <article class=\"tech-item\"><code>deterministic</code><h3>Rules are checked by code</h3><p>No model call in the blocking path. Same change, same rules, same verdict.</p></article>",
          "      <article class=\"tech-item\"><code>git-native</code><h3>Your memory stays in your repo</h3><p>Plain JSON in <code class=\"literal\">.hunch/</code>. Review it in a PR, revert it, rebuild the index any time. No Hunch account.</p></article>",
          "      <article class=\"tech-item\"><code>receipts</code><h3>Every claim shows its source</h3><p>A block cites the rule it enforces. A task report keeps apart what was delivered, what the agent said and what actually ran.</p></article>",
          "      <article class=\"tech-item\"><code>any assistant</code><h3>One memory, every assistant</h3><p>Claude Code, Codex, Cursor, VS Code/Copilot, Windsurf, Antigravity and other MCP clients. Hook coverage varies by assistant.</p></article>",
          "      <article class=\"tech-item\"><code>no meter</code><h3>No per-token bill</h3><p>Drafting runs on the assistant subscription you already have, or a deterministic local fallback. Metered APIs stay off unless you opt in.</p></article>",
          "      <article class=\"tech-item\"><code>human-gated</code><h3>People decide what’s true</h3><p>Advice by default. Nothing blocks until a person trusts the rule, and an agent can’t change a record a human confirmed.</p></article>",
        ],
        tr: [
          "      <article class=\"tech-item\"><code>حتمي</code><h3>القواعد تفحصها الشيفرة</h3><p>لا استدعاء لنموذج في مسار الحظر. التغيير نفسه، القواعد نفسها، الحكم نفسه.</p></article>",
          "      <article class=\"tech-item\"><code>مبني على Git</code><h3>ذاكرتك تبقى في مستودعك</h3><p>JSON عادي داخل <code class=\"literal\">.hunch/</code>. راجعه في PR، وتراجع عنه، وأعد بناء الفهرس متى شئت. بلا حساب Hunch.</p></article>",
          "      <article class=\"tech-item\"><code>إيصالات</code><h3>كل ادّعاء يُظهر مصدره</h3><p>الحظر يذكر القاعدة التي يطبّقها. وتقرير المهمة يفصل بين ما سُلّم، وما قاله الوكيل، وما نُفّذ فعلًا.</p></article>",
          "      <article class=\"tech-item\"><code>أي مساعد</code><h3>ذاكرة واحدة، لكل مساعد</h3><p>Claude Code وCodex وCursor وVS Code/Copilot وWindsurf وAntigravity وغيرها من عملاء MCP. تغطية الخطافات تختلف من مساعد إلى آخر.</p></article>",
          "      <article class=\"tech-item\"><code>بلا عدّاد</code><h3>بلا فاتورة على كل توكن</h3><p>الصياغة تعمل على اشتراك المساعد الذي لديك أصلًا، أو على بديل محلي حتمي. وواجهات API المدفوعة بحسب الاستخدام تبقى معطّلة ما لم تفعّلها أنت.</p></article>",
          "      <article class=\"tech-item\"><code>بموافقة بشرية</code><h3>البشر يقرّرون ما هو صحيح</h3><p>إرشاد افتراضيًا. لا يُحظر شيء حتى يثق إنسان بالقاعدة، ولا يستطيع وكيل تغيير سجل أكّده إنسان.</p></article>",
        ],
      },
      {
        en: [
          "      <span class=\"eyebrow\">how hunch works</span>",
          "      <h2>Remember. Retrieve. Check.</h2>",
          "      <p>Hunch briefs the agent, then checks its work. The agent still writes the code.</p>",
        ],
        tr: [
          "      <span class=\"eyebrow\">كيف يعمل Hunch</span>",
          "      <h2>تذكّر. استرجع. تحقّق.</h2>",
          "      <p>يزوّد Hunch الوكيل بإحاطة، ثم يتحقق من عمله. وتبقى كتابة الشيفرة على الوكيل.</p>",
        ],
      },
      {
        en: [
          "      <article class=\"outcome\"><span class=\"step-n\">01 / remember</span><h3>Save what you learned.</h3><p>Decisions, corrections and findings, linked to the code and the source they came from.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">02 / retrieve</span><h3>Bring it back at the right moment.</h3><p>When a task starts, Hunch picks the memory that matters and delivers it through MCP or your assistant’s hooks.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">03 / check</span><h3>Check, then show the receipt.</h3><p>Hunch runs the rules you trust and writes a task report: what it delivered, what the agent used, what passed.</p></article>",
        ],
        tr: [
          "      <article class=\"outcome\"><span class=\"step-n\">01 / تذكّر</span><h3>احفظ ما تعلّمته.</h3><p>القرارات والتصحيحات والملاحظات، مرتبطة بالشيفرة والمصدر الذي جاءت منه.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">02 / استرجع</span><h3>استعده في اللحظة المناسبة.</h3><p>عند بدء المهمة، يختار Hunch الذاكرة المهمة ويسلّمها عبر MCP أو خطافات مساعدك.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">03 / تحقّق</span><h3>تحقّق، ثم اعرض الإيصال.</h3><p>ينفّذ Hunch القواعد التي تثق بها ويكتب تقرير مهمة: ما سلّمه، وما استخدمه الوكيل، وما نجح.</p></article>",
        ],
      },
      {
        en: [
          "        <h3>Watch a rule hold.</h3>",
          "        <p>An agent reaches for the one thing your team ruled out. The check stops the commit and names the rule.</p>",
        ],
        tr: [
          "        <h3>شاهد قاعدة تصمد.</h3>",
          "        <p>وكيل يمدّ يده إلى الشيء الوحيد الذي استبعده فريقك. يوقف الفحص الإيداع ويسمّي القاعدة.</p>",
        ],
      },
      {
        en: [
          "          <li>No model in the blocking path</li>",
          "          <li>Cites the rule, the file and the reason</li>",
          "          <li>Runs before a commit and in CI</li>",
        ],
        tr: [
          "          <li>لا نموذج في مسار الحظر</li>",
          "          <li>يذكر القاعدة والملف والسبب</li>",
          "          <li>يعمل قبل الإيداع وفي CI</li>",
        ],
      },
      {
        en: [
          "          <div class=\"term-bar\"><i></i><i></i><i></i>&nbsp; ~/acme-checkout<button class=\"replay\" type=\"button\" hidden>Replay</button></div>",
          "          <pre data-typed><span class=\"tl c-key\"># your team's rule: never import lodash — use src/utils</span>",
          "<span class=\"tl c-key\"># an agent just staged:  + import _ from \"lodash\"</span>",
        ],
        tr: [
          "          <div class=\"term-bar\"><i></i><i></i><i></i>&nbsp; ~/acme-checkout<button class=\"replay\" type=\"button\" hidden>إعادة التشغيل</button></div>",
          "          <pre data-typed><span class=\"tl c-key\"># قاعدة فريقك: never import lodash — use src/utils</span>",
          "<span class=\"tl c-key\"># وكيل أضاف للتوّ إلى الإيداع:  + import _ from \"lodash\"</span>",
        ],
      },
      {
        en: [
          "        <p class=\"demo-note\">Example session; the rule id is illustrative. Run the real one: <a href=\"https://github.com/davesheffer/hunch/blob/main/demo/hunch-blocks-it.sh\">demo/hunch-blocks-it.sh</a></p>",
        ],
        tr: [
          "        <p class=\"demo-note\">جلسة توضيحية؛ ومعرّف القاعدة للتمثيل فقط. شغّل النسخة الحقيقية: <a href=\"https://github.com/davesheffer/hunch/blob/main/demo/hunch-blocks-it.sh\"><bdi dir=\"ltr\">demo/hunch-blocks-it.sh</bdi></a></p>",
        ],
      },
      {
        en: [
          "          <span class=\"eyebrow\">see the evidence</span>",
          "          <h2 id=\"release-proof-title\">Don’t trust the agent. Read the receipt.</h2>",
          "          <p class=\"release-copy\">Every task report keeps apart three things most tools blur together.</p>",
        ],
        tr: [
          "          <span class=\"eyebrow\">اطّلع على الأدلة</span>",
          "          <h2 id=\"release-proof-title\">لا تثق بالوكيل. اقرأ الإيصال.</h2>",
          "          <p class=\"release-copy\">يفصل كل تقرير مهمة بين ثلاثة أمور تخلط بينها معظم الأدوات.</p>",
        ],
      },
      {
        en: [
          "      <div class=\"release-metrics\" aria-label=\"What task reports distinguish\">",
          "        <div class=\"release-metric\"><strong>delivered</strong><span>what Hunch handed the agent</span></div>",
          "        <div class=\"release-metric\"><strong>reported</strong><span>what the agent says it used</span></div>",
          "        <div class=\"release-metric\"><strong>checked</strong><span>what rules and commands actually ran</span></div>",
        ],
        tr: [
          "      <div class=\"release-metrics\" aria-label=\"ما تميّز بينه تقارير المهام\">",
          "        <div class=\"release-metric\"><strong>مقدّم</strong><span>ما سلّمه Hunch للوكيل</span></div>",
          "        <div class=\"release-metric\"><strong>مُبلّغ عنه</strong><span>ما يقول الوكيل إنه استخدمه</span></div>",
          "        <div class=\"release-metric\"><strong>مفحوص</strong><span>القواعد والأوامر التي نُفّذت فعلًا</span></div>",
        ],
      },
      {
        en: [
          "      <p class=\"release-caveat\">A green test alone doesn’t prove Hunch helped. No evidence, no claim: it stays unverified. <a href=\"/docs#task-reports\">Read a task report →</a></p>",
        ],
        tr: [
          "      <p class=\"release-caveat\">نجاح اختبار وحده لا يثبت أن Hunch أفاد. لا دليل، لا ادّعاء: يبقى غير متحقق منه. <a href=\"/docs#task-reports\">اقرأ تقرير مهمة ←</a></p>",
        ],
      },
      {
        en: [
          "        <span class=\"eyebrow\">new in 1.52</span>",
          "        <h2>What’s new in Hunch.</h2>",
        ],
        tr: [
          "        <span class=\"eyebrow\">الجديد في 1.52</span>",
          "        <h2>ما الجديد في Hunch.</h2>",
        ],
      },
      {
        en: [
          "      <p>The headlines from the last few releases. The rest is in the <a href=\"/ar/changelog\">changelog</a>.</p>",
        ],
        tr: [
          "      <p>أبرز ما جاء في الإصدارات الأخيرة. والبقية في <a href=\"/ar/changelog\">سجل التغييرات</a>.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">hunch ui</span><span class=\"new-ver\">1.52</span></div>",
          "        <h3>Your repo’s memory, in your browser.</h3>",
          "        <p>Browse, search, edit, link, remove and restore records in a local web UI. It runs on your machine, and only your click writes memory.</p>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag literal\">hunch ui</span><span class=\"new-ver\">1.52</span></div>",
          "        <h3>ذاكرة مستودعك، في متصفحك.</h3>",
          "        <p>تصفّح السجلات وابحث فيها وعدّلها واربطها واحذفها واستعدها في واجهة ويب محلية. تعمل على جهازك، ولا يكتب في الذاكرة إلا نقرتك.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">Deliberate · Grill me</span><span class=\"new-ver\">1.52</span></div>",
          "        <h3>A review queue for what needs a person.</h3>",
          "        <p>Deliberate ranks conflicts, stale links, duplicates and weak memory. Grill me questions a record, up to five questions, with secret-looking files withheld.</p>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag literal\">Deliberate · Grill me</span><span class=\"new-ver\">1.52</span></div>",
          "        <h3>طابور مراجعة لما يحتاج إلى إنسان.</h3>",
          "        <p>يرتّب Deliberate التعارضات والروابط القديمة والتكرارات والذاكرة الضعيفة. ويستجوب Grill me سجلًا، بخمسة أسئلة على الأكثر، مع حجب الملفات التي تبدو أسرارًا.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">Elixir</span><span class=\"new-ver\">1.52</span></div>",
          "        <h3>Elixir joins the graph.</h3>",
          "        <p>Blast radius, dependents and rule checks now work on Elixir, next to TypeScript, JavaScript, Python, Go and PHP. Static analysis, no LLM.</p>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag literal\">Elixir</span><span class=\"new-ver\">1.52</span></div>",
          "        <h3>Elixir تنضم إلى المخطط البياني.</h3>",
          "        <p>نطاق التأثير، وما يعتمد على الشيفرة، وفحوص القواعد تعمل الآن مع Elixir، إلى جانب TypeScript وJavaScript وPython وGo وPHP. تحليل ساكن، بلا LLM.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">hunch derive-rules</span><span class=\"new-ver\">1.49</span></div>",
          "        <h3>Write the rule in your docs. Hunch enforces it.</h3>",
          "        <p>Mark a sentence with <code>&lt;!-- hunch:rule scope=… --&gt;</code> and it becomes a constraint. <code>--check</code> fails CI when doc and graph disagree.</p>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag literal\">hunch derive-rules</span><span class=\"new-ver\">1.49</span></div>",
          "        <h3>اكتب القاعدة في وثائقك. وHunch يطبّقها.</h3>",
          "        <p>علّم جملة بـ<code>&lt;!-- hunch:rule scope=… --&gt;</code> فتصير قيدًا. و<code>--check</code> يُفشل CI عندما تختلف الوثيقة والمخطط البياني.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">hunch verify</span><span class=\"new-ver\">1.46</span></div>",
          "        <h3>Run only the tests a change needs.</h3>",
          "        <p>Hunch picks the tests that import or ran the changed code. Doubt means more tests: a change it can’t trace runs the full suite.</p>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag literal\">hunch verify</span><span class=\"new-ver\">1.46</span></div>",
          "        <h3>شغّل فقط الاختبارات التي يحتاجها التغيير.</h3>",
          "        <p>يختار Hunch الاختبارات التي تستورد الشيفرة المتغيّرة أو شغّلتها. الشك يعني اختبارات أكثر: التغيير الذي يتعذّر تتبّعه يشغّل المجموعة كاملة.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">hooks</span><span class=\"new-ver\">1.51</span></div>",
          "        <h3>Hooks that stay out of your way.</h3>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag\">الخطافات</span><span class=\"new-ver\">1.51</span></div>",
          "        <h3>خطافات لا تعترض طريقك.</h3>",
        ],
      },
      {
        en: [
          "          <caption class=\"sr-only\">Median hook time before and after 1.51.0, in milliseconds</caption>",
        ],
        tr: [
          "          <caption class=\"sr-only\">وسيط زمن الخطاف قبل 1.51.0 وبعده، بالمللي ثانية</caption>",
        ],
      },
      {
        en: [
          "            <tr><th scope=\"row\">When a task stops</th><td>2174 → <b>298 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Before an edit</th><td>500 → <b>334 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Per prompt</th><td>299 → <b>213 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Session start</th><td>251 → <b>148 ms</b></td></tr>",
        ],
        tr: [
          "            <tr><th scope=\"row\">عند توقّف المهمة</th><td>2174 → <b>298 ms</b></td></tr>",
          "            <tr><th scope=\"row\">قبل التعديل</th><td>500 → <b>334 ms</b></td></tr>",
          "            <tr><th scope=\"row\">لكل برومبت</th><td>299 → <b>213 ms</b></td></tr>",
          "            <tr><th scope=\"row\">بدء الجلسة</th><td>251 → <b>148 ms</b></td></tr>",
        ],
      },
      {
        en: [
          "        <p class=\"new-cap\">Median hook time on the benchmark VM, before and after 1.51.0. Hook output is identical.</p>",
        ],
        tr: [
          "        <p class=\"new-cap\">وسيط زمن الخطاف على VM اختبار الأداء، قبل 1.51.0 وبعده. مخرجات الخطافات متطابقة.</p>",
        ],
      },
      {
        en: [
          "        <div class=\"new-top\"><span class=\"new-tag\">memory home</span><span class=\"new-ver\">1.51</span></div>",
          "        <h3>One memory per repository.</h3>",
          "        <p>Worktrees and extra clones of a repo share one memory home, chosen from the repo’s identity, not the folder you’re in.</p>",
        ],
        tr: [
          "        <div class=\"new-top\"><span class=\"new-tag\">موطن الذاكرة</span><span class=\"new-ver\">1.51</span></div>",
          "        <h3>ذاكرة واحدة لكل مستودع.</h3>",
          "        <p>أشجار العمل (worktrees) والنسخ الإضافية من المستودع تتشارك موطن ذاكرة واحدًا، يُختار من هوية المستودع، لا من المجلد الذي أنت فيه.</p>",
        ],
      },
      {
        en: [
          "      <summary>Also new since 1.44</summary>",
        ],
        tr: [
          "      <summary>جديد أيضًا منذ 1.44</summary>",
        ],
      },
      {
        en: [
          "        <li><span>1.51</span><div><code>hunch log --for &lt;commit&gt;</code> shows which memory led to which feature commit.</div></li>",
          "        <li><span>1.51</span><div><code>hunch mcp</code> answers the handshake in 1.7–3.7 s. With a large overlay on Windows it used to take 28–76 s.</div></li>",
          "        <li><span>1.50</span><div>A correction can retire the rule it reverses. Nothing is deleted.</div></li>",
          "        <li><span>1.50</span><div>When a test run fails, the hook names the past bug it matches.</div></li>",
          "        <li><span>1.48</span><div>Licensed FSL-1.1-ALv2. Each release converts to Apache-2.0 two years after it ships.</div></li>",
          "        <li><span>1.45</span><div><code>hunch init</code> configures only the assistants it finds.</div></li>",
          "        <li><span>1.44</span><div><code>hunch uninstall</code> removes what Hunch installed and keeps your memory.</div></li>",
          "        <li><span>1.44</span><div>Agent writes over MCP can’t change a record a human confirmed.</div></li>",
        ],
        tr: [
          "        <li><span>1.51</span><div><code>hunch log --for &lt;commit&gt;</code> يُظهر أي ذاكرة قادت إلى أي إيداع لميزة.</div></li>",
          "        <li><span>1.51</span><div><code>hunch mcp</code> يردّ على المصافحة خلال <bdi dir=\"ltr\">1.7–3.7 s</bdi>. ومع overlay كبير على Windows كان يستغرق <bdi dir=\"ltr\">28–76 s</bdi>.</div></li>",
          "        <li><span>1.50</span><div>يمكن للتصحيح أن يُحيل إلى التقاعد القاعدة التي يعكسها. ولا يُحذف شيء.</div></li>",
          "        <li><span>1.50</span><div>عند فشل تشغيل الاختبارات، يسمّي الخطاف الخطأ السابق الذي يطابقه.</div></li>",
          "        <li><span>1.48</span><div>مرخّص بـ<bdi dir=\"ltr\">FSL-1.1-ALv2</bdi>. ويتحوّل كل إصدار إلى <bdi dir=\"ltr\">Apache-2.0</bdi> بعد عامين من صدوره.</div></li>",
          "        <li><span>1.45</span><div><code>hunch init</code> يهيّئ فقط المساعدين الذين يجدهم.</div></li>",
          "        <li><span>1.44</span><div><code>hunch uninstall</code> يزيل ما ثبّته Hunch ويُبقي ذاكرتك.</div></li>",
          "        <li><span>1.44</span><div>كتابات الوكلاء عبر MCP لا تستطيع تغيير سجل أكّده إنسان.</div></li>",
        ],
      },
      {
        en: [
          "        <span class=\"eyebrow\">under the hood</span>",
          "        <h2>Know what a change breaks before you make it.</h2>",
        ],
        tr: [
          "        <span class=\"eyebrow\">ما وراء الواجهة</span>",
          "        <h2>اعرف ما سيكسره التغيير قبل أن تجريه.</h2>",
        ],
      },
      {
        en: [
          "      <p>Hunch ties each reason to the code’s real dependencies and to the rules your team chose to protect.</p>",
        ],
        tr: [
          "      <p>يربط Hunch كل سبب بالاعتماديات الفعلية للشيفرة وبالقواعد التي اختار فريقك حمايتها.</p>",
        ],
      },
      {
        en: [
          "      <article class=\"tech-item\"><code class=\"literal\">hunch why</code><h3>Find the reason</h3><p>The decisions, rejected ideas and past bugs behind any file or symbol.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch impact</code><h3>See what depends on it</h3><p>Follow the code’s real connections to everything a change can reach.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch check</code><h3>Guard the rules you trust</h3><p>Flags a change that breaks a trusted rule. Strict mode blocks only where that rule and your assistant allow it.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch conform</code><h3>Check the code keeps its promises</h3><p>For example: does the payment path still check authorization?</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch drift</code><h3>Catch docs that fell behind</h3><p>A doc still pinned to a replaced decision fails <code class=\"literal\">hunch drift</code>, so CI can catch it.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch dna inspect</code><h3>Learn the house style</h3><p>The terms and habits Hunch observed in this repo. Advice only.</p></article>",
        ],
        tr: [
          "      <article class=\"tech-item\"><code class=\"literal\">hunch why</code><h3>اعثر على السبب</h3><p>القرارات والأفكار المرفوضة والأخطاء السابقة وراء أي ملف أو رمز برمجي.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch impact</code><h3>اعرف ما يعتمد عليه</h3><p>تتبّع الروابط الفعلية في الشيفرة إلى كل ما يمكن أن يصل إليه التغيير.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch check</code><h3>احمِ القواعد التي تثق بها</h3><p>ينبّه إلى تغيير يخالف قاعدة موثوقة. ولا يحظر الوضع الصارم إلا حيث تسمح القاعدة ومساعدك بذلك.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch conform</code><h3>تحقّق أن الشيفرة تفي بوعودها</h3><p>مثلًا: هل لا يزال مسار الدفع يتحقق من الصلاحيات؟</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch drift</code><h3>التقط الوثائق التي تخلّفت</h3><p>الوثيقة التي ما زالت مثبّتة على قرار مُستبدَل تُفشل <code class=\"literal\">hunch drift</code>، فيلتقطها CI.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch dna inspect</code><h3>تعرّف على أسلوب المشروع</h3><p>المصطلحات والعادات التي رصدها Hunch في هذا المستودع. إرشاد فقط.</p></article>",
        ],
      },
      {
        en: [
          "    <p class=\"tech-link\">Indexes TypeScript, JavaScript, Python, Go, PHP and Elixir, plus Helm, Kustomize and YAML. Beyond code, <code>hunch serve</code> is a self-hosted service that <a href=\"/docs#shared-state\">shares decisions, finished work and open commitments</a> across agents. <a href=\"/docs\">Read the docs →</a></p>",
        ],
        tr: [
          "    <p class=\"tech-link\">يفهرس TypeScript وJavaScript وPython وGo وPHP وElixir، إضافة إلى Helm وKustomize وYAML. وخارج الشيفرة، <code>hunch serve</code> خدمة مستضافة ذاتيًا <a href=\"/docs#shared-state\">تشارك القرارات والعمل المنجز والالتزامات المفتوحة</a> بين الوكلاء. <a href=\"/docs\">اقرأ الوثائق ←</a></p>",
        ],
      },
      {
        en: [
          "      <span class=\"eyebrow\">get started</span>",
          "      <h2>Start in one repository.</h2>",
          "      <p>Needs Node 22.13+ and a Git repository. No Hunch account.</p>",
        ],
        tr: [
          "      <span class=\"eyebrow\">ابدأ</span>",
          "      <h2>ابدأ من مستودع واحد.</h2>",
          "      <p>يتطلب <bdi dir=\"ltr\">Node 22.13+</bdi> ومستودع Git. بلا حساب Hunch.</p>",
        ],
      },
      {
        en: [
          "          <div class=\"step\"><span class=\"step-n\">01</span><div><h3>Install and connect</h3><p>Install the CLI, then run <code>hunch init</code> in your project. It sets up only the assistants you have.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">02</span><div><h3>Teach it your history</h3><p>Optional: draft memory from the last 90 days of Git, then review what it captured.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">03</span><div><h3>Ask why</h3><p>Reload your assistant and ask why a file is built this way. Using Codex? Trust the hooks in <code>/hooks</code> first.</p></div></div>",
        ],
        tr: [
          "          <div class=\"step\"><span class=\"step-n\">01</span><div><h3>ثبّت واربط</h3><p>ثبّت أداة CLI، ثم شغّل <code>hunch init</code> داخل مشروعك. يهيّئ فقط المساعدين الموجودين لديك.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">02</span><div><h3>علّمه تاريخك</h3><p>اختياري: صُغ ذاكرة من آخر 90 يومًا في Git، ثم راجع ما التقطه.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">03</span><div><h3>اسأل لماذا</h3><p>أعد تحميل المساعد واسأله لماذا بُني ملف بهذه الطريقة. تستخدم Codex؟ أكّد الثقة بالخطافات أولًا عبر <code>/hooks</code>.</p></div></div>",
        ],
      },
      {
        en: [
          "        <div class=\"prov\" role=\"group\" aria-label=\"Supported assistants\">",
          "          <span>Claude Code</span><span>Codex</span><span>Cursor</span><span>VS Code / Copilot</span><span>Windsurf</span><span>Antigravity</span><span>any MCP client</span>",
        ],
        tr: [
          "        <div class=\"prov\" role=\"group\" aria-label=\"المساعدون المدعومون\">",
          "          <span>Claude Code</span><span>Codex</span><span>Cursor</span><span>VS Code / Copilot</span><span>Windsurf</span><span>Antigravity</span><span class=\"local\">أي عميل MCP</span>",
        ],
      },
      {
        en: [
          "          <pre style=\"min-height:0\"><span class=\"c-key\"># install from npm</span>",
        ],
        tr: [
          "          <pre style=\"min-height:0\"><span class=\"c-key\"># التثبيت من npm</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># connect Hunch to this project</span>",
        ],
        tr: [
          "<span class=\"c-key\"># ربط Hunch بهذا المشروع</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># learn from the last 90 days</span>",
        ],
        tr: [
          "<span class=\"c-key\"># التعلّم من آخر 90 يومًا</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># ask what a file is for</span>",
        ],
        tr: [
          "<span class=\"c-key\"># اسأل عن الغرض من ملف</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># browse your memory in the browser</span>",
        ],
        tr: [
          "<span class=\"c-key\"># تصفّح ذاكرتك في المتصفح</span>",
        ],
      },
      {
        en: [
          "          <button class=\"copybtn\" type=\"button\" data-clip=\"#install-cmd\" data-clip-done=\"Copied\"><svg class=\"clip-ico\" viewBox=\"0 0 16 16\" aria-hidden=\"true\" focusable=\"false\"><g class=\"ico-copy\"><rect x=\"5.5\" y=\"5.5\" width=\"8\" height=\"8\" rx=\"1.6\"/><path d=\"M10.5 3.5v-.4a1.6 1.6 0 0 0-1.6-1.6H3.1a1.6 1.6 0 0 0-1.6 1.6v5.8a1.6 1.6 0 0 0 1.6 1.6h.4\"/></g><path class=\"ico-check\" d=\"M3 8.6l3.2 3.2L13 4.9\"/></svg><span class=\"clip-label\">Copy</span></button>",
        ],
        tr: [
          "          <button class=\"copybtn\" type=\"button\" data-clip=\"#install-cmd\" data-clip-done=\"تم النسخ\"><svg class=\"clip-ico\" viewBox=\"0 0 16 16\" aria-hidden=\"true\" focusable=\"false\"><g class=\"ico-copy\"><rect x=\"5.5\" y=\"5.5\" width=\"8\" height=\"8\" rx=\"1.6\"/><path d=\"M10.5 3.5v-.4a1.6 1.6 0 0 0-1.6-1.6H3.1a1.6 1.6 0 0 0-1.6 1.6v5.8a1.6 1.6 0 0 0 1.6 1.6h.4\"/></g><path class=\"ico-check\" d=\"M3 8.6l3.2 3.2L13 4.9\"/></svg><span class=\"clip-label\">نسخ</span></button>",
        ],
      },
      {
        en: [
          "          <li>Advice by default. Nothing blocks until you say so.</li>",
          "          <li>Update with <code>hunch update</code>. Leave with <code>hunch uninstall</code>: it removes what Hunch installed and keeps your memory.</li>",
          "          <li>Claude Code? Install as a plugin: <code>/plugin marketplace add davesheffer/hunch</code> → <code>/plugin install hunch@hunch</code></li>",
          "          <li>VS Code? <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">Get the extension on Open VSX</a></li>",
        ],
        tr: [
          "          <li>إرشاد افتراضيًا. لا يُحظر شيء حتى تقرّر أنت.</li>",
          "          <li>حدّث عبر <code>hunch update</code>. وغادر عبر <code>hunch uninstall</code>: يزيل ما ثبّته Hunch ويُبقي ذاكرتك.</li>",
          "          <li>تستخدم Claude Code؟ ثبّته كإضافة: <code>/plugin marketplace add davesheffer/hunch</code> ← <code>/plugin install hunch@hunch</code></li>",
          "          <li>VS Code؟ <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">احصل على الإضافة من Open VSX</a></li>",
        ],
      },
      {
        en: [
          "    <h2>Stop re-explaining your codebase.</h2>",
          "    <p>Give every agent the same memory and every change the same check. It advises by default, and one command removes it.</p>",
        ],
        tr: [
          "    <h2>توقّف عن إعادة شرح شيفرتك.</h2>",
          "    <p>امنح كل وكيل الذاكرة نفسها، وكل تغيير الفحص نفسه. يقدّم الإرشاد افتراضيًا، وأمر واحد يزيله.</p>",
        ],
      },
      {
        en: [
          "      <a class=\"btn\" href=\"#start\">Get started</a>",
          "      <a class=\"btn ghost\" href=\"/docs\">Read the docs</a>",
        ],
        tr: [
          "      <a class=\"btn\" href=\"#start\">ابدأ الآن</a>",
          "      <a class=\"btn ghost\" href=\"/docs\">اقرأ الوثائق</a>",
        ],
      },
      {
        en: [
          "      <p class=\"about\">Hunch keeps the why behind your code, in Git, for every assistant you use.</p>",
          "      <p class=\"about\">FSL-1.1-ALv2. Use it for your own work, internal or commercial. Each release becomes Apache-2.0 two years after it ships.</p>",
        ],
        tr: [
          "      <p class=\"about\">يحفظ Hunch «لماذا» وراء شيفرتك، في Git، لكل مساعد تستخدمه.</p>",
          "      <p class=\"about\"><bdi dir=\"ltr\">FSL-1.1-ALv2</bdi>. استخدمه في عملك، داخليًا أو تجاريًا. ويصير كل إصدار <bdi dir=\"ltr\">Apache-2.0</bdi> بعد عامين من صدوره.</p>",
        ],
      },
      {
        en: [
          "      <h4>product</h4>",
          "      <a href=\"#how\">How it works</a>",
          "      <a href=\"#new\">What’s new</a>",
          "      <a href=\"#inside\">Under the hood</a>",
          "      <a href=\"/compare\">Compare</a>",
          "      <a href=\"/ar/changelog\">Changelog</a>",
        ],
        tr: [
          "      <h4>المنتج</h4>",
          "      <a href=\"#how\">كيف يعمل</a>",
          "      <a href=\"#new\">ما الجديد</a>",
          "      <a href=\"#inside\">ما وراء الواجهة</a>",
          "      <a href=\"/compare\">مقارنة</a>",
          "      <a href=\"/ar/changelog\">سجل التغييرات</a>",
        ],
      },
      {
        en: [
          "      <h4>develop</h4>",
          "      <a href=\"#start\">Get started</a>",
          "      <a href=\"/docs\">Docs</a>",
          "      <a href=\"/docs#mcp\">MCP tools</a>",
          "      <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">VS Code extension</a>",
        ],
        tr: [
          "      <h4>التطوير</h4>",
          "      <a href=\"#start\">ابدأ الآن</a>",
          "      <a href=\"/docs\">الوثائق</a>",
          "      <a href=\"/docs#mcp\">أدوات MCP</a>",
          "      <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">إضافة VS Code</a>",
        ],
      },
      {
        en: [
          "      <h4>connect</h4>",
        ],
        tr: [
          "      <h4>روابط</h4>",
        ],
      },
      {
        en: [
          "      <a href=\"/ar/blog\">Blog</a>",
        ],
        tr: [
          "      <a href=\"/ar/blog\">المدوّنة</a>",
        ],
      },
      {
        en: [
          "    const RECEIPTS = [\"dec_8b2e · held\", \"dec_a466 · held\", \"dec_e0a3 · held\", \"dec_fd36 · held\"];",
          "    const BLOCKS = [\"con_9027 · blocked\", \"con_2ce3 · blocked\"];",
        ],
        tr: [
          "    const RECEIPTS = [\"dec_8b2e · محفوظ\", \"dec_a466 · محفوظ\", \"dec_e0a3 · محفوظ\", \"dec_fd36 · محفوظ\"];",
          "    const BLOCKS = [\"con_9027 · محظور\", \"con_2ce3 · محظور\"];",
        ],
      },
      {
        en: [
          "      { label: \"decision\", angle: -2.55 },",
          "      { label: \"bug\", angle: -0.18 },",
          "      { label: \"rule\", angle: 1.72 },",
        ],
        tr: [
          "      { label: \"قرار\", angle: -2.55 },",
          "      { label: \"خطأ\", angle: -0.18 },",
          "      { label: \"قاعدة\", angle: 1.72 },",
        ],
      },
      {
        en: [
          "      ctx.fillText(\"why\", x, y + 0.5);",
        ],
        tr: [
          "      ctx.fillText(\"لماذا\", x, y + 0.5);",
        ],
      },
      {
        en: [
          "        ctx.fillText(\"reason recalled before edit\", x, y + r + 34);",
        ],
        tr: [
          "        ctx.fillText(\"استُعيد السبب قبل التعديل\", x, y + r + 34);",
        ],
      },
    ],
  },
  es: {
    dir: "ltr",
    ogLocale: "es_ES",
    hunks: [
      {
        en: [
          "  <title>Hunch — Shared memory for AI agents</title>",
          "  <meta name=\"description\" content=\"Hunch keeps the why behind your code in Git: decisions, past bugs and the rules that must hold. Every AI coding assistant gets it before it edits, and deterministic checks catch the change that breaks a rule.\" />",
          "  <meta property=\"og:title\" content=\"Hunch — Shared memory for AI agents\" />",
          "  <meta property=\"og:description\" content=\"Your agents forget. Hunch remembers: what you decided, what broke before and which rules must hold. In your Git repo, checked by code.\" />",
        ],
        tr: [
          "  <title>Hunch — Memoria compartida para agentes de IA</title>",
          "  <meta name=\"description\" content=\"Hunch guarda en Git el porqué de tu código: decisiones, errores pasados y las reglas que deben cumplirse. Cada asistente de programación con IA lo recibe antes de editar, y las comprobaciones deterministas detectan el cambio que rompe una regla.\" />",
          "  <meta property=\"og:title\" content=\"Hunch — Memoria compartida para agentes de IA\" />",
          "  <meta property=\"og:description\" content=\"Tus agentes olvidan. Hunch recuerda: lo que decidiste, lo que falló antes y qué reglas deben cumplirse. En tu repositorio Git, comprobado con código.\" />",
        ],
      },
      {
        en: [
          "  html[lang=\"he\"] .term-bar .replay,html[lang=\"ar\"] .term-bar .replay,html[lang=\"he\"] .new-tag:not(.literal),html[lang=\"ar\"] .new-tag:not(.literal){font-family:var(--sans-local);letter-spacing:0}",
        ],
        tr: [
          "  html[lang=\"he\"] .term-bar .replay,html[lang=\"ar\"] .term-bar .replay,html[lang=\"he\"] .new-tag:not(.literal),html[lang=\"ar\"] .new-tag:not(.literal){font-family:var(--sans-local);letter-spacing:0}",
          "  html[lang=\"ru\"] .term-bar .replay,html[lang=\"es\"] .term-bar .replay,html[lang=\"ru\"] .copybtn,html[lang=\"es\"] .copybtn{font-family:var(--sans);font-weight:500;letter-spacing:0}",
          "  html[lang=\"ru\"] .copyline,html[lang=\"es\"] .copyline{flex-wrap:wrap}",
          "  html[lang=\"ru\"] .hook-table th,html[lang=\"es\"] .hook-table th{padding-inline-end:14px}",
        ],
      },
      {
        en: [
          "<a class=\"skip\" href=\"#main\">Skip to content</a>",
          "<a class=\"thesis-band\" href=\"/es/blog/post?slug=the-state-layer\"><span class=\"thesis-tag\">Deterministic State</span><span class=\"thesis-text\">What deterministic state means, in plain words.</span><b class=\"thesis-cta\">Read the thesis →</b></a>",
          "<nav class=\"nav\" aria-label=\"Main\">",
        ],
        tr: [
          "<a class=\"skip\" href=\"#main\">Saltar al contenido</a>",
          "<a class=\"thesis-band\" href=\"/es/blog/post?slug=the-state-layer\"><span class=\"thesis-tag\">Estado determinista</span><span class=\"thesis-text\">Qué significa estado determinista, en palabras sencillas.</span><b class=\"thesis-cta\">Leer la tesis →</b></a>",
          "<nav class=\"nav\" aria-label=\"Navegación principal\">",
        ],
      },
      {
        en: [
          "      <a href=\"#how\" class=\"hide-s\">How it works</a>",
          "      <a href=\"#inside\" class=\"hide-s\">Under the hood</a>",
          "      <a href=\"/docs\" class=\"hide-xs\">Docs</a>",
        ],
        tr: [
          "      <a href=\"#how\" class=\"hide-s\">Cómo funciona</a>",
          "      <a href=\"#inside\" class=\"hide-s\">Cómo está hecho</a>",
          "      <a href=\"/docs\" class=\"hide-xs\">Documentación</a>",
        ],
      },
      {
        en: [
          "      <a href=\"/es/changelog\" class=\"hide-s\">Changelog</a>",
        ],
        tr: [
          "      <a href=\"/es/changelog\" class=\"hide-s\">Cambios</a>",
        ],
      },
      {
        en: [
          "        <span class=\"sr-only\">Language</span>",
          "        <select class=\"lang-select\" id=\"language-switch\" aria-label=\"Language\">",
        ],
        tr: [
          "        <span class=\"sr-only\">Idioma</span>",
          "        <select class=\"lang-select\" id=\"language-switch\" aria-label=\"Idioma\">",
        ],
      },
      {
        en: [
          "      <a class=\"btn\" href=\"#start\">Get started</a>",
        ],
        tr: [
          "      <a class=\"btn\" href=\"#start\">Empezar</a>",
        ],
      },
      {
        en: [
          "    <h1 class=\"rise d1\">Your agents forget.<br /><b>Hunch remembers.</b></h1>",
          "    <p class=\"lede rise d2\">Hunch keeps the why behind your code in your Git repo: what you decided, what broke before, which rules must hold. Your assistant gets it before it edits. Then Hunch checks the change — with code, not another model.</p>",
        ],
        tr: [
          "    <h1 class=\"rise d1\">Tus agentes olvidan.<br /><b>Hunch recuerda.</b></h1>",
          "    <p class=\"lede rise d2\">Hunch guarda el porqué de tu código en tu repositorio Git: lo que decidiste, lo que falló antes, qué reglas deben cumplirse. Tu asistente lo recibe antes de editar. Después, Hunch comprueba el cambio: con código, no con otro modelo.</p>",
        ],
      },
      {
        en: [
          "      <a class=\"btn\" href=\"#start\">Get started</a>",
          "      <a class=\"btn ghost\" href=\"#story\">See how it works</a>",
        ],
        tr: [
          "      <a class=\"btn\" href=\"#start\">Empezar</a>",
          "      <a class=\"btn ghost\" href=\"#story\">Ver cómo funciona</a>",
        ],
      },
      {
        en: [
          "      <span class=\"eyebrow\">the missing context</span>",
          "      <h2>AI reads your code. It wasn’t there when you decided.</h2>",
          "      <p>It sees what the code does. Not why, not what broke last time, not what a tidy-up will break next.</p>",
        ],
        tr: [
          "      <span class=\"eyebrow\">el contexto que falta</span>",
          "      <h2>La IA lee tu código. No estaba ahí cuando se decidió.</h2>",
          "      <p>Ve lo que hace el código. No el porqué, ni qué falló la última vez, ni qué romperá la próxima limpieza.</p>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">Monday</span>",
          "          <div><h3>Your team fixes a logout bug.</h3><p>Sign-ins move to the server, so a stolen key dies the moment someone logs out.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">Lunes</span>",
          "          <div><h3>Tu equipo corrige un error al cerrar sesión.</h3><p>El inicio de sesión pasa al servidor, así que una clave robada muere en cuanto alguien cierra sesión.</p></div>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">Months later</span>",
          "          <div><h3>The code stays. The reason doesn’t.</h3><p>The discussion is buried. The safe code just looks overcomplicated.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">Meses después</span>",
          "          <div><h3>El código se queda. La razón no.</h3><p>La discusión queda enterrada. El código seguro solo parece complicado de más.</p></div>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">Next session</span>",
          "          <div><h3>An AI “cleans it up.”</h3><p>The diff looks great. The logout bug is back.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">Siguiente sesión</span>",
          "          <div><h3>Una IA lo “limpia”.</h3><p>El diff se ve genial. El error del cierre de sesión vuelve.</p></div>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">With Hunch</span>",
          "          <div><h3>The reason shows up first.</h3><p>Once the lesson is recorded, Hunch puts the decision, and the bug it prevents, in front of the agent before it edits the file.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">Con Hunch</span>",
          "          <div><h3>Primero llega la razón.</h3><p>Una vez registrada la lección, Hunch pone la decisión, y el error que evita, delante del agente antes de que edite el archivo.</p></div>",
        ],
      },
      {
        en: [
          "      <aside class=\"receipt\" aria-label=\"Example project memory\">",
          "        <div class=\"receipt-head\"><span>before editing · <bdi>src/auth/session.ts</bdi></span><b>memory found</b></div>",
        ],
        tr: [
          "      <aside class=\"receipt\" aria-label=\"Ejemplo de memoria del proyecto\">",
          "        <div class=\"receipt-head\"><span>antes de editar · <bdi>src/auth/session.ts</bdi></span><b>memoria encontrada</b></div>",
        ],
      },
      {
        en: [
          "          <span class=\"receipt-kicker\">Why this code exists</span>",
          "          <h3>Logging out must end access right away.</h3>",
          "          <div class=\"receipt-row\"><span>chosen</span><p>Keep sign-ins on the server, where they can be ended at once.</p></div>",
          "          <div class=\"receipt-row\"><span>rejected</span><p>Trust a login token until its timer runs out.</p></div>",
          "          <div class=\"receipt-row\"><span>protects</span><p>A stolen token being used after logout.</p></div>",
          "          <p class=\"receipt-foot\">example memory · source attached · advice, not a block</p>",
        ],
        tr: [
          "          <span class=\"receipt-kicker\">Por qué existe este código</span>",
          "          <h3>Cerrar sesión debe poner fin al acceso de inmediato.</h3>",
          "          <div class=\"receipt-row\"><span>elegido</span><p>Guardar las sesiones en el servidor, donde pueden cerrarse al instante.</p></div>",
          "          <div class=\"receipt-row\"><span>descartado</span><p>Confiar en un token de acceso hasta que caduque.</p></div>",
          "          <div class=\"receipt-row\"><span>protege de</span><p>El uso de un token robado después de cerrar sesión.</p></div>",
          "          <p class=\"receipt-foot\">memoria de ejemplo · con fuente adjunta · un consejo, no un bloqueo</p>",
        ],
      },
      {
        en: [
          "      <button class=\"watch-frame\" type=\"button\" data-yt=\"m2PM6pV7D9Y\" aria-label=\"Play video: Hunch Memory in 2 minutes\">",
        ],
        tr: [
          "      <button class=\"watch-frame\" type=\"button\" data-yt=\"m2PM6pV7D9Y\" aria-label=\"Reproducir vídeo: Hunch Memory en 2 minutos\">",
        ],
      },
      {
        en: [
          "      <figcaption><b>Hunch Memory in 2 minutes.</b> Then the <a href=\"https://www.youtube.com/playlist?list=PLIXqtdE0LcNI\" target=\"_blank\" rel=\"noopener\">7-episode series</a>: setup, hooks, capture, delivery, rules, drift and teams.</figcaption>",
        ],
        tr: [
          "      <figcaption><b>Hunch Memory en 2 minutos</b> (en inglés). Después, la <a href=\"https://www.youtube.com/playlist?list=PLIXqtdE0LcNI\" target=\"_blank\" rel=\"noopener\">serie de 7 episodios</a>: instalación, hooks, captura, entrega, reglas, deriva y equipos.</figcaption>",
        ],
      },
      {
        en: [
          "        <span class=\"eyebrow\">why hunch</span>",
          "        <h2>Built to be checked, not trusted.</h2>",
        ],
        tr: [
          "        <span class=\"eyebrow\">por qué Hunch</span>",
          "        <h2>Hecho para que lo compruebes, no para que te fíes.</h2>",
        ],
      },
      {
        en: [
          "      <p>Six properties you can verify in the public source. <a href=\"/compare\">See how Hunch compares →</a></p>",
        ],
        tr: [
          "      <p>Seis propiedades que puedes verificar en el código fuente público. <a href=\"/compare\">Mira cómo se compara Hunch →</a></p>",
        ],
      },
      {
        en: [
          "      <article class=\"tech-item\"><code>deterministic</code><h3>Rules are checked by code</h3><p>No model call in the blocking path. Same change, same rules, same verdict.</p></article>",
          "      <article class=\"tech-item\"><code>git-native</code><h3>Your memory stays in your repo</h3><p>Plain JSON in <code class=\"literal\">.hunch/</code>. Review it in a PR, revert it, rebuild the index any time. No Hunch account.</p></article>",
          "      <article class=\"tech-item\"><code>receipts</code><h3>Every claim shows its source</h3><p>A block cites the rule it enforces. A task report keeps apart what was delivered, what the agent said and what actually ran.</p></article>",
          "      <article class=\"tech-item\"><code>any assistant</code><h3>One memory, every assistant</h3><p>Claude Code, Codex, Cursor, VS Code/Copilot, Windsurf, Antigravity and other MCP clients. Hook coverage varies by assistant.</p></article>",
          "      <article class=\"tech-item\"><code>no meter</code><h3>No per-token bill</h3><p>Drafting runs on the assistant subscription you already have, or a deterministic local fallback. Metered APIs stay off unless you opt in.</p></article>",
          "      <article class=\"tech-item\"><code>human-gated</code><h3>People decide what’s true</h3><p>Advice by default. Nothing blocks until a person trusts the rule, and an agent can’t change a record a human confirmed.</p></article>",
        ],
        tr: [
          "      <article class=\"tech-item\"><code>determinista</code><h3>Las reglas las comprueba el código</h3><p>Ninguna llamada a un modelo en la ruta de bloqueo. Mismo cambio, mismas reglas, mismo veredicto.</p></article>",
          "      <article class=\"tech-item\"><code>nativo de Git</code><h3>Tu memoria se queda en tu repositorio</h3><p>JSON simple en <code class=\"literal\">.hunch/</code>. Revísalo en un PR, revíertelo, reconstruye el índice cuando quieras. Sin cuenta de Hunch.</p></article>",
          "      <article class=\"tech-item\"><code>recibos</code><h3>Cada afirmación muestra su fuente</h3><p>Un bloqueo cita la regla que aplica. Un informe de tarea separa lo que se entregó, lo que dijo el agente y lo que realmente se ejecutó.</p></article>",
          "      <article class=\"tech-item\"><code>cualquier asistente</code><h3>Una memoria, todos los asistentes</h3><p>Claude Code, Codex, Cursor, VS Code/Copilot, Windsurf, Antigravity y otros clientes MCP. La cobertura de hooks varía según el asistente.</p></article>",
          "      <article class=\"tech-item\"><code>sin contador</code><h3>Sin factura por token</h3><p>Los borradores se generan con la suscripción de asistente que ya tienes o con una alternativa local determinista. Las API de pago por uso siguen desactivadas salvo que las actives tú.</p></article>",
          "      <article class=\"tech-item\"><code>decide una persona</code><h3>Las personas deciden qué es cierto</h3><p>Consejo por defecto. Nada se bloquea hasta que una persona confía en la regla, y un agente no puede cambiar un registro confirmado por una persona.</p></article>",
        ],
      },
      {
        en: [
          "      <span class=\"eyebrow\">how hunch works</span>",
          "      <h2>Remember. Retrieve. Check.</h2>",
          "      <p>Hunch briefs the agent, then checks its work. The agent still writes the code.</p>",
        ],
        tr: [
          "      <span class=\"eyebrow\">Cómo funciona Hunch</span>",
          "      <h2>Recordar. Recuperar. Comprobar.</h2>",
          "      <p>Hunch pone al día al agente y luego comprueba su trabajo. El código lo sigue escribiendo el agente.</p>",
        ],
      },
      {
        en: [
          "      <article class=\"outcome\"><span class=\"step-n\">01 / remember</span><h3>Save what you learned.</h3><p>Decisions, corrections and findings, linked to the code and the source they came from.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">02 / retrieve</span><h3>Bring it back at the right moment.</h3><p>When a task starts, Hunch picks the memory that matters and delivers it through MCP or your assistant’s hooks.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">03 / check</span><h3>Check, then show the receipt.</h3><p>Hunch runs the rules you trust and writes a task report: what it delivered, what the agent used, what passed.</p></article>",
        ],
        tr: [
          "      <article class=\"outcome\"><span class=\"step-n\">01 / recordar</span><h3>Guarda lo que aprendiste.</h3><p>Decisiones, correcciones y hallazgos, vinculados al código y a la fuente de la que salieron.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">02 / recuperar</span><h3>Tráelo en el momento justo.</h3><p>Al empezar una tarea, Hunch elige la memoria que importa y la entrega por MCP o por los hooks de tu asistente.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">03 / comprobar</span><h3>Comprueba y enseña el recibo.</h3><p>Hunch ejecuta las reglas en las que confías y escribe un informe de tarea: qué entregó, qué usó el agente, qué pasó las comprobaciones.</p></article>",
        ],
      },
      {
        en: [
          "        <h3>Watch a rule hold.</h3>",
          "        <p>An agent reaches for the one thing your team ruled out. The check stops the commit and names the rule.</p>",
        ],
        tr: [
          "        <h3>Mira cómo una regla se mantiene firme.</h3>",
          "        <p>Un agente recurre justo a lo que tu equipo descartó. La comprobación detiene el commit y nombra la regla.</p>",
        ],
      },
      {
        en: [
          "          <li>No model in the blocking path</li>",
          "          <li>Cites the rule, the file and the reason</li>",
          "          <li>Runs before a commit and in CI</li>",
        ],
        tr: [
          "          <li>Ningún modelo en la ruta de bloqueo</li>",
          "          <li>Cita la regla, el archivo y el motivo</li>",
          "          <li>Se ejecuta antes de un commit y en CI</li>",
        ],
      },
      {
        en: [
          "          <div class=\"term-bar\"><i></i><i></i><i></i>&nbsp; ~/acme-checkout<button class=\"replay\" type=\"button\" hidden>Replay</button></div>",
          "          <pre data-typed><span class=\"tl c-key\"># your team's rule: never import lodash — use src/utils</span>",
          "<span class=\"tl c-key\"># an agent just staged:  + import _ from \"lodash\"</span>",
        ],
        tr: [
          "          <div class=\"term-bar\"><i></i><i></i><i></i>&nbsp; ~/acme-checkout<button class=\"replay\" type=\"button\" hidden>Repetir</button></div>",
          "          <pre data-typed><span class=\"tl c-key\"># la regla de tu equipo: never import lodash — use src/utils</span>",
          "<span class=\"tl c-key\"># un agente acaba de añadir al stage:  + import _ from \"lodash\"</span>",
        ],
      },
      {
        en: [
          "        <p class=\"demo-note\">Example session; the rule id is illustrative. Run the real one: <a href=\"https://github.com/davesheffer/hunch/blob/main/demo/hunch-blocks-it.sh\">demo/hunch-blocks-it.sh</a></p>",
        ],
        tr: [
          "        <p class=\"demo-note\">Sesión de ejemplo; el id de la regla es ilustrativo. Ejecuta la real: <a href=\"https://github.com/davesheffer/hunch/blob/main/demo/hunch-blocks-it.sh\">demo/hunch-blocks-it.sh</a></p>",
        ],
      },
      {
        en: [
          "          <span class=\"eyebrow\">see the evidence</span>",
          "          <h2 id=\"release-proof-title\">Don’t trust the agent. Read the receipt.</h2>",
          "          <p class=\"release-copy\">Every task report keeps apart three things most tools blur together.</p>",
        ],
        tr: [
          "          <span class=\"eyebrow\">consulta las pruebas</span>",
          "          <h2 id=\"release-proof-title\">No confíes en el agente. Lee el recibo.</h2>",
          "          <p class=\"release-copy\">Cada informe de tarea separa tres cosas que la mayoría de las herramientas mezclan.</p>",
        ],
      },
      {
        en: [
          "      <div class=\"release-metrics\" aria-label=\"What task reports distinguish\">",
          "        <div class=\"release-metric\"><strong>delivered</strong><span>what Hunch handed the agent</span></div>",
          "        <div class=\"release-metric\"><strong>reported</strong><span>what the agent says it used</span></div>",
          "        <div class=\"release-metric\"><strong>checked</strong><span>what rules and commands actually ran</span></div>",
        ],
        tr: [
          "      <div class=\"release-metrics\" aria-label=\"Qué distinguen los informes de tarea\">",
          "        <div class=\"release-metric\"><strong>entregado</strong><span>lo que Hunch entregó al agente</span></div>",
          "        <div class=\"release-metric\"><strong>declarado</strong><span>lo que el agente dice haber usado</span></div>",
          "        <div class=\"release-metric\"><strong>comprobado</strong><span>qué reglas y comandos se ejecutaron realmente</span></div>",
        ],
      },
      {
        en: [
          "      <p class=\"release-caveat\">A green test alone doesn’t prove Hunch helped. No evidence, no claim: it stays unverified. <a href=\"/docs#task-reports\">Read a task report →</a></p>",
        ],
        tr: [
          "      <p class=\"release-caveat\">Una prueba verde por sí sola no demuestra que Hunch ayudara. Sin pruebas, no hay afirmación: sigue sin verificar. <a href=\"/docs#task-reports\">Lee un informe de tarea →</a></p>",
        ],
      },
      {
        en: [
          "        <span class=\"eyebrow\">new in 1.52</span>",
          "        <h2>What’s new in Hunch.</h2>",
        ],
        tr: [
          "        <span class=\"eyebrow\">nuevo en 1.52</span>",
          "        <h2>Novedades de Hunch.</h2>",
        ],
      },
      {
        en: [
          "      <p>The headlines from the last few releases. The rest is in the <a href=\"/es/changelog\">changelog</a>.</p>",
        ],
        tr: [
          "      <p>Lo más destacado de las últimas versiones. El resto está en el <a href=\"/es/changelog\">registro de cambios</a>.</p>",
        ],
      },
      {
        en: [
          "        <h3>Your repo’s memory, in your browser.</h3>",
          "        <p>Browse, search, edit, link, remove and restore records in a local web UI. It runs on your machine, and only your click writes memory.</p>",
        ],
        tr: [
          "        <h3>La memoria de tu repositorio, en tu navegador.</h3>",
          "        <p>Explora, busca, edita, enlaza, elimina y restaura registros en una interfaz web local. Se ejecuta en tu máquina, y solo tu clic escribe en la memoria.</p>",
        ],
      },
      {
        en: [
          "        <h3>A review queue for what needs a person.</h3>",
          "        <p>Deliberate ranks conflicts, stale links, duplicates and weak memory. Grill me questions a record, up to five questions, with secret-looking files withheld.</p>",
        ],
        tr: [
          "        <h3>Una cola de revisión para lo que necesita a una persona.</h3>",
          "        <p>Deliberate ordena por prioridad conflictos, enlaces obsoletos, duplicados y memoria débil. Grill me interroga un registro, con un máximo de cinco preguntas, y deja fuera los archivos que parecen contener secretos.</p>",
        ],
      },
      {
        en: [
          "        <h3>Elixir joins the graph.</h3>",
          "        <p>Blast radius, dependents and rule checks now work on Elixir, next to TypeScript, JavaScript, Python, Go and PHP. Static analysis, no LLM.</p>",
        ],
        tr: [
          "        <h3>Elixir se une al grafo.</h3>",
          "        <p>El alcance del cambio, los dependientes y las comprobaciones de reglas ya funcionan en Elixir, junto a TypeScript, JavaScript, Python, Go y PHP. Análisis estático, sin LLM.</p>",
        ],
      },
      {
        en: [
          "        <h3>Write the rule in your docs. Hunch enforces it.</h3>",
          "        <p>Mark a sentence with <code>&lt;!-- hunch:rule scope=… --&gt;</code> and it becomes a constraint. <code>--check</code> fails CI when doc and graph disagree.</p>",
        ],
        tr: [
          "        <h3>Escribe la regla en tu documentación. Hunch la hace cumplir.</h3>",
          "        <p>Marca una frase con <code>&lt;!-- hunch:rule scope=… --&gt;</code> y se convierte en una restricción. <code>--check</code> hace fallar la CI cuando la documentación y el grafo no coinciden.</p>",
        ],
      },
      {
        en: [
          "        <h3>Run only the tests a change needs.</h3>",
          "        <p>Hunch picks the tests that import or ran the changed code. Doubt means more tests: a change it can’t trace runs the full suite.</p>",
        ],
        tr: [
          "        <h3>Ejecuta solo las pruebas que un cambio necesita.</h3>",
          "        <p>Hunch elige las pruebas que importan o ejecutaron el código modificado. Ante la duda, más pruebas: un cambio que no puede rastrear ejecuta la suite completa.</p>",
        ],
      },
      {
        en: [
          "        <h3>Hooks that stay out of your way.</h3>",
        ],
        tr: [
          "        <h3>Hooks que no estorban.</h3>",
        ],
      },
      {
        en: [
          "          <caption class=\"sr-only\">Median hook time before and after 1.51.0, in milliseconds</caption>",
        ],
        tr: [
          "          <caption class=\"sr-only\">Tiempo mediano de los hooks antes y después de la 1.51.0, en milisegundos</caption>",
        ],
      },
      {
        en: [
          "            <tr><th scope=\"row\">When a task stops</th><td>2174 → <b>298 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Before an edit</th><td>500 → <b>334 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Per prompt</th><td>299 → <b>213 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Session start</th><td>251 → <b>148 ms</b></td></tr>",
        ],
        tr: [
          "            <tr><th scope=\"row\">Al detenerse una tarea</th><td>2174 → <b>298 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Antes de una edición</th><td>500 → <b>334 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Por prompt</th><td>299 → <b>213 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Arranque de la sesión</th><td>251 → <b>148 ms</b></td></tr>",
        ],
      },
      {
        en: [
          "        <p class=\"new-cap\">Median hook time on the benchmark VM, before and after 1.51.0. Hook output is identical.</p>",
        ],
        tr: [
          "        <p class=\"new-cap\">Tiempo mediano de los hooks en la VM de benchmark, antes y después de la 1.51.0. La salida de los hooks es idéntica.</p>",
        ],
      },
      {
        en: [
          "        <h3>One memory per repository.</h3>",
          "        <p>Worktrees and extra clones of a repo share one memory home, chosen from the repo’s identity, not the folder you’re in.</p>",
        ],
        tr: [
          "        <h3>Una memoria por repositorio.</h3>",
          "        <p>Los worktrees y los clones adicionales de un repositorio comparten una misma ubicación de memoria, elegida según la identidad del repositorio, no según la carpeta en la que estás.</p>",
        ],
      },
      {
        en: [
          "      <summary>Also new since 1.44</summary>",
        ],
        tr: [
          "      <summary>También nuevo desde la 1.44</summary>",
        ],
      },
      {
        en: [
          "        <li><span>1.51</span><div><code>hunch log --for &lt;commit&gt;</code> shows which memory led to which feature commit.</div></li>",
          "        <li><span>1.51</span><div><code>hunch mcp</code> answers the handshake in 1.7–3.7 s. With a large overlay on Windows it used to take 28–76 s.</div></li>",
          "        <li><span>1.50</span><div>A correction can retire the rule it reverses. Nothing is deleted.</div></li>",
          "        <li><span>1.50</span><div>When a test run fails, the hook names the past bug it matches.</div></li>",
          "        <li><span>1.48</span><div>Licensed FSL-1.1-ALv2. Each release converts to Apache-2.0 two years after it ships.</div></li>",
          "        <li><span>1.45</span><div><code>hunch init</code> configures only the assistants it finds.</div></li>",
          "        <li><span>1.44</span><div><code>hunch uninstall</code> removes what Hunch installed and keeps your memory.</div></li>",
          "        <li><span>1.44</span><div>Agent writes over MCP can’t change a record a human confirmed.</div></li>",
        ],
        tr: [
          "        <li><span>1.51</span><div><code>hunch log --for &lt;commit&gt;</code> muestra qué memoria llevó a qué commit de funcionalidad.</div></li>",
          "        <li><span>1.51</span><div><code>hunch mcp</code> responde al handshake en 1,7–3,7 s. Con un overlay grande en Windows antes tardaba 28–76 s.</div></li>",
          "        <li><span>1.50</span><div>Una corrección puede retirar la regla que revierte. No se borra nada.</div></li>",
          "        <li><span>1.50</span><div>Cuando falla una ejecución de pruebas, el hook nombra el error pasado con el que coincide.</div></li>",
          "        <li><span>1.48</span><div>Licencia FSL-1.1-ALv2. Cada versión pasa a Apache-2.0 dos años después de publicarse.</div></li>",
          "        <li><span>1.45</span><div><code>hunch init</code> configura solo los asistentes que encuentra.</div></li>",
          "        <li><span>1.44</span><div><code>hunch uninstall</code> elimina lo que Hunch instaló y conserva tu memoria.</div></li>",
          "        <li><span>1.44</span><div>Las escrituras de agentes por MCP no pueden cambiar un registro confirmado por una persona.</div></li>",
        ],
      },
      {
        en: [
          "        <span class=\"eyebrow\">under the hood</span>",
          "        <h2>Know what a change breaks before you make it.</h2>",
        ],
        tr: [
          "        <span class=\"eyebrow\">bajo el capó</span>",
          "        <h2>Sabe qué rompe un cambio antes de hacerlo.</h2>",
        ],
      },
      {
        en: [
          "      <p>Hunch ties each reason to the code’s real dependencies and to the rules your team chose to protect.</p>",
        ],
        tr: [
          "      <p>Hunch vincula cada razón con las dependencias reales del código y con las reglas que tu equipo eligió proteger.</p>",
        ],
      },
      {
        en: [
          "      <article class=\"tech-item\"><code class=\"literal\">hunch why</code><h3>Find the reason</h3><p>The decisions, rejected ideas and past bugs behind any file or symbol.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch impact</code><h3>See what depends on it</h3><p>Follow the code’s real connections to everything a change can reach.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch check</code><h3>Guard the rules you trust</h3><p>Flags a change that breaks a trusted rule. Strict mode blocks only where that rule and your assistant allow it.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch conform</code><h3>Check the code keeps its promises</h3><p>For example: does the payment path still check authorization?</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch drift</code><h3>Catch docs that fell behind</h3><p>A doc still pinned to a replaced decision fails <code class=\"literal\">hunch drift</code>, so CI can catch it.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch dna inspect</code><h3>Learn the house style</h3><p>The terms and habits Hunch observed in this repo. Advice only.</p></article>",
        ],
        tr: [
          "      <article class=\"tech-item\"><code class=\"literal\">hunch why</code><h3>Encuentra el motivo</h3><p>Las decisiones, ideas descartadas y errores pasados detrás de cualquier archivo o símbolo.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch impact</code><h3>Mira qué depende de él</h3><p>Sigue las conexiones reales del código hasta todo lo que un cambio puede alcanzar.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch check</code><h3>Protege las reglas en las que confías</h3><p>Señala un cambio que rompe una regla de confianza. El modo estricto solo bloquea donde esa regla y tu asistente lo permiten.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch conform</code><h3>Verifica que el código cumple sus promesas</h3><p>Por ejemplo: ¿la ruta de pago sigue comprobando la autorización?</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch drift</code><h3>Detecta la documentación que se quedó atrás</h3><p>Un documento que sigue anclado a una decisión reemplazada hace fallar <code class=\"literal\">hunch drift</code>, así que la CI puede detectarlo.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch dna inspect</code><h3>Aprende el estilo de la casa</h3><p>Los términos y hábitos que Hunch observó en este repositorio. Solo como consejo.</p></article>",
        ],
      },
      {
        en: [
          "    <p class=\"tech-link\">Indexes TypeScript, JavaScript, Python, Go, PHP and Elixir, plus Helm, Kustomize and YAML. Beyond code, <code>hunch serve</code> is a self-hosted service that <a href=\"/docs#shared-state\">shares decisions, finished work and open commitments</a> across agents. <a href=\"/docs\">Read the docs →</a></p>",
        ],
        tr: [
          "    <p class=\"tech-link\">Indexa TypeScript, JavaScript, Python, Go, PHP y Elixir, además de Helm, Kustomize y YAML. Más allá del código, <code>hunch serve</code> es un servicio autoalojado que <a href=\"/docs#shared-state\">comparte decisiones, trabajo terminado y compromisos abiertos</a> entre agentes. <a href=\"/docs\">Lee la documentación →</a></p>",
        ],
      },
      {
        en: [
          "      <span class=\"eyebrow\">get started</span>",
          "      <h2>Start in one repository.</h2>",
          "      <p>Needs Node 22.13+ and a Git repository. No Hunch account.</p>",
        ],
        tr: [
          "      <span class=\"eyebrow\">primeros pasos</span>",
          "      <h2>Empieza en un solo repositorio.</h2>",
          "      <p>Requiere Node 22.13+ y un repositorio Git. Sin cuenta de Hunch.</p>",
        ],
      },
      {
        en: [
          "          <div class=\"step\"><span class=\"step-n\">01</span><div><h3>Install and connect</h3><p>Install the CLI, then run <code>hunch init</code> in your project. It sets up only the assistants you have.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">02</span><div><h3>Teach it your history</h3><p>Optional: draft memory from the last 90 days of Git, then review what it captured.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">03</span><div><h3>Ask why</h3><p>Reload your assistant and ask why a file is built this way. Using Codex? Trust the hooks in <code>/hooks</code> first.</p></div></div>",
        ],
        tr: [
          "          <div class=\"step\"><span class=\"step-n\">01</span><div><h3>Instala y conecta</h3><p>Instala la CLI y ejecuta <code>hunch init</code> en tu proyecto. Configura solo los asistentes que tienes.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">02</span><div><h3>Enséñale tu historia</h3><p>Opcional: genera un borrador de memoria a partir de los últimos 90 días de Git y revisa lo que capturó.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">03</span><div><h3>Pregunta por qué</h3><p>Recarga tu asistente y pregunta por qué un archivo está hecho así. ¿Usas Codex? Confía primero en los hooks desde <code>/hooks</code>.</p></div></div>",
        ],
      },
      {
        en: [
          "        <div class=\"prov\" role=\"group\" aria-label=\"Supported assistants\">",
          "          <span>Claude Code</span><span>Codex</span><span>Cursor</span><span>VS Code / Copilot</span><span>Windsurf</span><span>Antigravity</span><span>any MCP client</span>",
        ],
        tr: [
          "        <div class=\"prov\" role=\"group\" aria-label=\"Asistentes compatibles\">",
          "          <span>Claude Code</span><span>Codex</span><span>Cursor</span><span>VS Code / Copilot</span><span>Windsurf</span><span>Antigravity</span><span>cualquier cliente MCP</span>",
        ],
      },
      {
        en: [
          "          <pre style=\"min-height:0\"><span class=\"c-key\"># install from npm</span>",
        ],
        tr: [
          "          <pre style=\"min-height:0\"><span class=\"c-key\"># instalación desde npm</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># connect Hunch to this project</span>",
        ],
        tr: [
          "<span class=\"c-key\"># conecta Hunch al proyecto y a tus asistentes</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># learn from the last 90 days</span>",
        ],
        tr: [
          "<span class=\"c-key\"># aprende opcionalmente de los últimos 90 días</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># ask what a file is for</span>",
        ],
        tr: [
          "<span class=\"c-key\"># pregunta para qué sirve un archivo</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># browse your memory in the browser</span>",
        ],
        tr: [
          "<span class=\"c-key\"># explora tu memoria en el navegador</span>",
        ],
      },
      {
        en: [
          "          <button class=\"copybtn\" type=\"button\" data-clip=\"#install-cmd\" data-clip-done=\"Copied\"><svg class=\"clip-ico\" viewBox=\"0 0 16 16\" aria-hidden=\"true\" focusable=\"false\"><g class=\"ico-copy\"><rect x=\"5.5\" y=\"5.5\" width=\"8\" height=\"8\" rx=\"1.6\"/><path d=\"M10.5 3.5v-.4a1.6 1.6 0 0 0-1.6-1.6H3.1a1.6 1.6 0 0 0-1.6 1.6v5.8a1.6 1.6 0 0 0 1.6 1.6h.4\"/></g><path class=\"ico-check\" d=\"M3 8.6l3.2 3.2L13 4.9\"/></svg><span class=\"clip-label\">Copy</span></button>",
        ],
        tr: [
          "          <button class=\"copybtn\" type=\"button\" data-clip=\"#install-cmd\" data-clip-done=\"Copiado\"><svg class=\"clip-ico\" viewBox=\"0 0 16 16\" aria-hidden=\"true\" focusable=\"false\"><g class=\"ico-copy\"><rect x=\"5.5\" y=\"5.5\" width=\"8\" height=\"8\" rx=\"1.6\"/><path d=\"M10.5 3.5v-.4a1.6 1.6 0 0 0-1.6-1.6H3.1a1.6 1.6 0 0 0-1.6 1.6v5.8a1.6 1.6 0 0 0 1.6 1.6h.4\"/></g><path class=\"ico-check\" d=\"M3 8.6l3.2 3.2L13 4.9\"/></svg><span class=\"clip-label\">Copiar</span></button>",
        ],
      },
      {
        en: [
          "          <li>Advice by default. Nothing blocks until you say so.</li>",
          "          <li>Update with <code>hunch update</code>. Leave with <code>hunch uninstall</code>: it removes what Hunch installed and keeps your memory.</li>",
          "          <li>Claude Code? Install as a plugin: <code>/plugin marketplace add davesheffer/hunch</code> → <code>/plugin install hunch@hunch</code></li>",
          "          <li>VS Code? <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">Get the extension on Open VSX</a></li>",
        ],
        tr: [
          "          <li>Consejo por defecto. Nada se bloquea hasta que tú lo decidas.</li>",
          "          <li>Actualiza con <code>hunch update</code>. Si quieres dejarlo, usa <code>hunch uninstall</code>: elimina lo que Hunch instaló y conserva tu memoria.</li>",
          "          <li>¿Usas Claude Code? Instálalo como plugin: <code>/plugin marketplace add davesheffer/hunch</code> → <code>/plugin install hunch@hunch</code></li>",
          "          <li>¿VS Code? <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">Consigue la extensión en Open VSX</a></li>",
        ],
      },
      {
        en: [
          "    <h2>Stop re-explaining your codebase.</h2>",
          "    <p>Give every agent the same memory and every change the same check. It advises by default, and one command removes it.</p>",
        ],
        tr: [
          "    <h2>Deja de explicar tu código una y otra vez.</h2>",
          "    <p>Dale a cada agente la misma memoria y a cada cambio la misma comprobación. Por defecto solo aconseja, y un comando lo elimina.</p>",
        ],
      },
      {
        en: [
          "      <a class=\"btn\" href=\"#start\">Get started</a>",
          "      <a class=\"btn ghost\" href=\"/docs\">Read the docs</a>",
        ],
        tr: [
          "      <a class=\"btn\" href=\"#start\">Empezar</a>",
          "      <a class=\"btn ghost\" href=\"/docs\">Leer la documentación</a>",
        ],
      },
      {
        en: [
          "      <p class=\"about\">Hunch keeps the why behind your code, in Git, for every assistant you use.</p>",
          "      <p class=\"about\">FSL-1.1-ALv2. Use it for your own work, internal or commercial. Each release becomes Apache-2.0 two years after it ships.</p>",
        ],
        tr: [
          "      <p class=\"about\">Hunch guarda el porqué de tu código, en Git, para todos los asistentes que usas.</p>",
          "      <p class=\"about\">FSL-1.1-ALv2. Úsalo en tu propio trabajo, interno o comercial. Cada versión pasa a ser Apache-2.0 dos años después de publicarse.</p>",
        ],
      },
      {
        en: [
          "      <h4>product</h4>",
          "      <a href=\"#how\">How it works</a>",
          "      <a href=\"#new\">What’s new</a>",
          "      <a href=\"#inside\">Under the hood</a>",
        ],
        tr: [
          "      <h4>producto</h4>",
          "      <a href=\"#how\">Cómo funciona</a>",
          "      <a href=\"#new\">Novedades</a>",
          "      <a href=\"#inside\">Cómo está hecho</a>",
        ],
      },
      {
        en: [
          "      <a href=\"/es/changelog\">Changelog</a>",
        ],
        tr: [
          "      <a href=\"/es/changelog\">Cambios</a>",
        ],
      },
      {
        en: [
          "      <h4>develop</h4>",
          "      <a href=\"#start\">Get started</a>",
          "      <a href=\"/docs\">Docs</a>",
          "      <a href=\"/docs#mcp\">MCP tools</a>",
          "      <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">VS Code extension</a>",
        ],
        tr: [
          "      <h4>desarrollo</h4>",
          "      <a href=\"#start\">Empezar</a>",
          "      <a href=\"/docs\">Documentación</a>",
          "      <a href=\"/docs#mcp\">Herramientas MCP</a>",
          "      <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">Extensión de VS Code</a>",
        ],
      },
      {
        en: [
          "      <h4>connect</h4>",
        ],
        tr: [
          "      <h4>enlaces</h4>",
        ],
      },
      {
        en: [
          "    const RECEIPTS = [\"dec_8b2e · held\", \"dec_a466 · held\", \"dec_e0a3 · held\", \"dec_fd36 · held\"];",
          "    const BLOCKS = [\"con_9027 · blocked\", \"con_2ce3 · blocked\"];",
        ],
        tr: [
          "    const RECEIPTS = [\"dec_8b2e · conservado\", \"dec_a466 · conservado\", \"dec_e0a3 · conservado\", \"dec_fd36 · conservado\"];",
          "    const BLOCKS = [\"con_9027 · bloqueado\", \"con_2ce3 · bloqueado\"];",
        ],
      },
      {
        en: [
          "      { label: \"decision\", angle: -2.55 },",
          "      { label: \"bug\", angle: -0.18 },",
          "      { label: \"rule\", angle: 1.72 },",
        ],
        tr: [
          "      { label: \"decisión\", angle: -2.55 },",
          "      { label: \"error\", angle: -0.18 },",
          "      { label: \"regla\", angle: 1.72 },",
        ],
      },
      {
        en: [
          "      ctx.fillText(\"why\", x, y + 0.5);",
        ],
        tr: [
          "      ctx.fillText(\"por qué\", x, y + 0.5);",
        ],
      },
      {
        en: [
          "        ctx.fillText(\"reason recalled before edit\", x, y + r + 34);",
        ],
        tr: [
          "        ctx.fillText(\"razón recuperada antes de editar\", x, y + r + 34);",
        ],
      },
    ],
  },
  ru: {
    dir: "ltr",
    ogLocale: "ru_RU",
    hunks: [
      {
        en: [
          "  <title>Hunch — Shared memory for AI agents</title>",
          "  <meta name=\"description\" content=\"Hunch keeps the why behind your code in Git: decisions, past bugs and the rules that must hold. Every AI coding assistant gets it before it edits, and deterministic checks catch the change that breaks a rule.\" />",
          "  <meta property=\"og:title\" content=\"Hunch — Shared memory for AI agents\" />",
          "  <meta property=\"og:description\" content=\"Your agents forget. Hunch remembers: what you decided, what broke before and which rules must hold. In your Git repo, checked by code.\" />",
        ],
        tr: [
          "  <title>Hunch — общая память для ИИ-агентов</title>",
          "  <meta name=\"description\" content=\"Hunch хранит в Git причины, стоящие за вашим кодом: решения, прошлые ошибки и правила, которые нельзя нарушать. Каждый ИИ-помощник для программирования получает их до правки, а детерминированные проверки ловят изменение, которое нарушает правило.\" />",
          "  <meta property=\"og:title\" content=\"Hunch — общая память для ИИ-агентов\" />",
          "  <meta property=\"og:description\" content=\"Ваши агенты забывают. Hunch помнит: что вы решили, что ломалось раньше и какие правила должны соблюдаться. В вашем Git-репозитории, с проверкой кодом.\" />",
        ],
      },
      {
        en: [
          "  html[lang=\"he\"] .term-bar .replay,html[lang=\"ar\"] .term-bar .replay,html[lang=\"he\"] .new-tag:not(.literal),html[lang=\"ar\"] .new-tag:not(.literal){font-family:var(--sans-local);letter-spacing:0}",
        ],
        tr: [
          "  html[lang=\"he\"] .term-bar .replay,html[lang=\"ar\"] .term-bar .replay,html[lang=\"he\"] .new-tag:not(.literal),html[lang=\"ar\"] .new-tag:not(.literal){font-family:var(--sans-local);letter-spacing:0}",
          "  html[lang=\"ru\"] .term-bar .replay,html[lang=\"es\"] .term-bar .replay,html[lang=\"ru\"] .copybtn,html[lang=\"es\"] .copybtn{font-family:var(--sans);font-weight:500;letter-spacing:0}",
          "  html[lang=\"ru\"] .copyline,html[lang=\"es\"] .copyline{flex-wrap:wrap}",
          "  html[lang=\"ru\"] .hook-table th,html[lang=\"es\"] .hook-table th{padding-inline-end:14px}",
        ],
      },
      {
        en: [
          "<a class=\"skip\" href=\"#main\">Skip to content</a>",
          "<a class=\"thesis-band\" href=\"/ru/blog/post?slug=the-state-layer\"><span class=\"thesis-tag\">Deterministic State</span><span class=\"thesis-text\">What deterministic state means, in plain words.</span><b class=\"thesis-cta\">Read the thesis →</b></a>",
          "<nav class=\"nav\" aria-label=\"Main\">",
        ],
        tr: [
          "<a class=\"skip\" href=\"#main\">Перейти к содержимому</a>",
          "<a class=\"thesis-band\" href=\"/ru/blog/post?slug=the-state-layer\"><span class=\"thesis-tag\">Детерминированное состояние</span><span class=\"thesis-text\">Что такое детерминированное состояние, простыми словами.</span><b class=\"thesis-cta\">Читать тезис →</b></a>",
          "<nav class=\"nav\" aria-label=\"Основная навигация\">",
        ],
      },
      {
        en: [
          "      <a href=\"#how\" class=\"hide-s\">How it works</a>",
          "      <a href=\"#inside\" class=\"hide-s\">Under the hood</a>",
          "      <a href=\"/docs\" class=\"hide-xs\">Docs</a>",
          "      <a href=\"/ru/blog\" class=\"hide-xs\">Blog</a>",
          "      <a href=\"/ru/changelog\" class=\"hide-s\">Changelog</a>",
        ],
        tr: [
          "      <a href=\"#how\" class=\"hide-s\">Как это работает</a>",
          "      <a href=\"#inside\" class=\"hide-s\">Что внутри</a>",
          "      <a href=\"/docs\" class=\"hide-xs\">Документация</a>",
          "      <a href=\"/ru/blog\" class=\"hide-xs\">Блог</a>",
          "      <a href=\"/ru/changelog\" class=\"hide-s\">История изменений</a>",
        ],
      },
      {
        en: [
          "        <span class=\"sr-only\">Language</span>",
          "        <select class=\"lang-select\" id=\"language-switch\" aria-label=\"Language\">",
        ],
        tr: [
          "        <span class=\"sr-only\">Язык</span>",
          "        <select class=\"lang-select\" id=\"language-switch\" aria-label=\"Язык\">",
        ],
      },
      {
        en: [
          "      <a class=\"btn\" href=\"#start\">Get started</a>",
        ],
        tr: [
          "      <a class=\"btn\" href=\"#start\">Начать</a>",
        ],
      },
      {
        en: [
          "    <h1 class=\"rise d1\">Your agents forget.<br /><b>Hunch remembers.</b></h1>",
          "    <p class=\"lede rise d2\">Hunch keeps the why behind your code in your Git repo: what you decided, what broke before, which rules must hold. Your assistant gets it before it edits. Then Hunch checks the change — with code, not another model.</p>",
        ],
        tr: [
          "    <h1 class=\"rise d1\">Ваши агенты забывают.<br /><b>Hunch помнит.</b></h1>",
          "    <p class=\"lede rise d2\">Hunch хранит в вашем Git-репозитории причины, стоящие за кодом: что вы решили, что ломалось раньше, какие правила должны соблюдаться. Помощник получает их до правки. Затем Hunch проверяет изменение — кодом, а не ещё одной моделью.</p>",
        ],
      },
      {
        en: [
          "      <a class=\"btn\" href=\"#start\">Get started</a>",
          "      <a class=\"btn ghost\" href=\"#story\">See how it works</a>",
        ],
        tr: [
          "      <a class=\"btn\" href=\"#start\">Начать</a>",
          "      <a class=\"btn ghost\" href=\"#story\">Посмотреть, как это работает</a>",
        ],
      },
      {
        en: [
          "      <span class=\"eyebrow\">the missing context</span>",
          "      <h2>AI reads your code. It wasn’t there when you decided.</h2>",
          "      <p>It sees what the code does. Not why, not what broke last time, not what a tidy-up will break next.</p>",
        ],
        tr: [
          "      <span class=\"eyebrow\">недостающий контекст</span>",
          "      <h2>ИИ читает ваш код. Но его не было рядом, когда вы решали.</h2>",
          "      <p>Он видит, что делает код. Но не знает почему, что ломалось в прошлый раз и что сломает очередная «чистка».</p>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">Monday</span>",
          "          <div><h3>Your team fixes a logout bug.</h3><p>Sign-ins move to the server, so a stolen key dies the moment someone logs out.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">Понедельник</span>",
          "          <div><h3>Команда исправляет ошибку выхода из аккаунта.</h3><p>Вход переносят на сервер, чтобы украденный ключ переставал работать сразу после выхода из аккаунта.</p></div>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">Months later</span>",
          "          <div><h3>The code stays. The reason doesn’t.</h3><p>The discussion is buried. The safe code just looks overcomplicated.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">Через несколько месяцев</span>",
          "          <div><h3>Код остаётся. Причина теряется.</h3><p>Обсуждение похоронено. Безопасный код просто выглядит излишне сложным.</p></div>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">Next session</span>",
          "          <div><h3>An AI “cleans it up.”</h3><p>The diff looks great. The logout bug is back.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">Следующий сеанс</span>",
          "          <div><h3>ИИ «наводит порядок».</h3><p>Диф выглядит отлично. Ошибка с выходом из аккаунта возвращается.</p></div>",
        ],
      },
      {
        en: [
          "          <span class=\"story-when\">With Hunch</span>",
          "          <div><h3>The reason shows up first.</h3><p>Once the lesson is recorded, Hunch puts the decision, and the bug it prevents, in front of the agent before it edits the file.</p></div>",
        ],
        tr: [
          "          <span class=\"story-when\">С Hunch</span>",
          "          <div><h3>Причина появляется первой.</h3><p>Когда урок записан, Hunch показывает агенту решение и ошибку, которую оно предотвращает, до правки файла.</p></div>",
        ],
      },
      {
        en: [
          "      <aside class=\"receipt\" aria-label=\"Example project memory\">",
          "        <div class=\"receipt-head\"><span>before editing · <bdi>src/auth/session.ts</bdi></span><b>memory found</b></div>",
        ],
        tr: [
          "      <aside class=\"receipt\" aria-label=\"Пример памяти проекта\">",
          "        <div class=\"receipt-head\"><span>перед изменением · <bdi>src/auth/session.ts</bdi></span><b>память найдена</b></div>",
        ],
      },
      {
        en: [
          "          <span class=\"receipt-kicker\">Why this code exists</span>",
          "          <h3>Logging out must end access right away.</h3>",
          "          <div class=\"receipt-row\"><span>chosen</span><p>Keep sign-ins on the server, where they can be ended at once.</p></div>",
          "          <div class=\"receipt-row\"><span>rejected</span><p>Trust a login token until its timer runs out.</p></div>",
          "          <div class=\"receipt-row\"><span>protects</span><p>A stolen token being used after logout.</p></div>",
          "          <p class=\"receipt-foot\">example memory · source attached · advice, not a block</p>",
        ],
        tr: [
          "          <span class=\"receipt-kicker\">Почему существует этот код</span>",
          "          <h3>Выход из аккаунта должен сразу прекращать доступ.</h3>",
          "          <div class=\"receipt-row\"><span>выбрано</span><p>Хранить данные о входе на сервере, где доступ можно сразу прекратить.</p></div>",
          "          <div class=\"receipt-row\"><span>отвергнуто</span><p>Доверять токену входа до истечения его срока действия.</p></div>",
          "          <div class=\"receipt-row\"><span>защищает от</span><p>Использования украденного токена после выхода из аккаунта.</p></div>",
          "          <p class=\"receipt-foot\">пример памяти · источник приложен · рекомендация, не блокировка</p>",
        ],
      },
      {
        en: [
          "      <button class=\"watch-frame\" type=\"button\" data-yt=\"m2PM6pV7D9Y\" aria-label=\"Play video: Hunch Memory in 2 minutes\">",
        ],
        tr: [
          "      <button class=\"watch-frame\" type=\"button\" data-yt=\"m2PM6pV7D9Y\" aria-label=\"Воспроизвести видео: Hunch Memory за 2 минуты\">",
        ],
      },
      {
        en: [
          "      <figcaption><b>Hunch Memory in 2 minutes.</b> Then the <a href=\"https://www.youtube.com/playlist?list=PLIXqtdE0LcNI\" target=\"_blank\" rel=\"noopener\">7-episode series</a>: setup, hooks, capture, delivery, rules, drift and teams.</figcaption>",
        ],
        tr: [
          "      <figcaption><b>Hunch Memory за 2 минуты</b> (на английском). Дальше — <a href=\"https://www.youtube.com/playlist?list=PLIXqtdE0LcNI\" target=\"_blank\" rel=\"noopener\">серия из 7 эпизодов</a>: установка, хуки, запись, доставка, правила, дрейф и команды.</figcaption>",
        ],
      },
      {
        en: [
          "        <span class=\"eyebrow\">why hunch</span>",
          "        <h2>Built to be checked, not trusted.</h2>",
        ],
        tr: [
          "        <span class=\"eyebrow\">почему Hunch</span>",
          "        <h2>Создан, чтобы его проверяли, а не верили на слово.</h2>",
        ],
      },
      {
        en: [
          "      <p>Six properties you can verify in the public source. <a href=\"/compare\">See how Hunch compares →</a></p>",
        ],
        tr: [
          "      <p>Шесть свойств, которые можно проверить в общедоступном исходном коде. <a href=\"/compare\">Сравнить Hunch с другими →</a></p>",
        ],
      },
      {
        en: [
          "      <article class=\"tech-item\"><code>deterministic</code><h3>Rules are checked by code</h3><p>No model call in the blocking path. Same change, same rules, same verdict.</p></article>",
          "      <article class=\"tech-item\"><code>git-native</code><h3>Your memory stays in your repo</h3><p>Plain JSON in <code class=\"literal\">.hunch/</code>. Review it in a PR, revert it, rebuild the index any time. No Hunch account.</p></article>",
          "      <article class=\"tech-item\"><code>receipts</code><h3>Every claim shows its source</h3><p>A block cites the rule it enforces. A task report keeps apart what was delivered, what the agent said and what actually ran.</p></article>",
          "      <article class=\"tech-item\"><code>any assistant</code><h3>One memory, every assistant</h3><p>Claude Code, Codex, Cursor, VS Code/Copilot, Windsurf, Antigravity and other MCP clients. Hook coverage varies by assistant.</p></article>",
          "      <article class=\"tech-item\"><code>no meter</code><h3>No per-token bill</h3><p>Drafting runs on the assistant subscription you already have, or a deterministic local fallback. Metered APIs stay off unless you opt in.</p></article>",
          "      <article class=\"tech-item\"><code>human-gated</code><h3>People decide what’s true</h3><p>Advice by default. Nothing blocks until a person trusts the rule, and an agent can’t change a record a human confirmed.</p></article>",
        ],
        tr: [
          "      <article class=\"tech-item\"><code>детерминированно</code><h3>Правила проверяет код</h3><p>В блокирующем пути нет вызовов модели. То же изменение, те же правила — тот же вердикт.</p></article>",
          "      <article class=\"tech-item\"><code>в Git</code><h3>Память остаётся в вашем репозитории</h3><p>Обычный JSON в <code class=\"literal\">.hunch/</code>. Проверьте его в PR, откатите, перестройте индекс в любой момент. Аккаунт Hunch не нужен.</p></article>",
          "      <article class=\"tech-item\"><code>с источниками</code><h3>У каждого утверждения есть источник</h3><p>Блокировка ссылается на правило, которое она применяет. Отчёт о задаче разделяет, что было передано, что сказал агент и что реально выполнялось.</p></article>",
          "      <article class=\"tech-item\"><code>любой помощник</code><h3>Одна память для всех помощников</h3><p>Claude Code, Codex, Cursor, VS Code/Copilot, Windsurf, Antigravity и другие MCP-клиенты. Поддержка хуков зависит от помощника.</p></article>",
          "      <article class=\"tech-item\"><code>без счётчика</code><h3>Никаких счетов за токены</h3><p>Черновики создаются по подписке на помощника, которая у вас уже есть, или детерминированным локальным резервным способом. API с оплатой по счётчику выключены, пока вы сами их не включите.</p></article>",
          "      <article class=\"tech-item\"><code>решает человек</code><h3>Что верно, решают люди</h3><p>По умолчанию — только рекомендации. Ничто не блокируется, пока человек не доверит правило, а агент не может изменить запись, подтверждённую человеком.</p></article>",
        ],
      },
      {
        en: [
          "      <span class=\"eyebrow\">how hunch works</span>",
          "      <h2>Remember. Retrieve. Check.</h2>",
          "      <p>Hunch briefs the agent, then checks its work. The agent still writes the code.</p>",
        ],
        tr: [
          "      <span class=\"eyebrow\">Как работает Hunch</span>",
          "      <h2>Помнить. Находить. Проверять.</h2>",
          "      <p>Hunch вводит агента в курс дела, а затем проверяет его работу. Код по-прежнему пишет агент.</p>",
        ],
      },
      {
        en: [
          "      <article class=\"outcome\"><span class=\"step-n\">01 / remember</span><h3>Save what you learned.</h3><p>Decisions, corrections and findings, linked to the code and the source they came from.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">02 / retrieve</span><h3>Bring it back at the right moment.</h3><p>When a task starts, Hunch picks the memory that matters and delivers it through MCP or your assistant’s hooks.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">03 / check</span><h3>Check, then show the receipt.</h3><p>Hunch runs the rules you trust and writes a task report: what it delivered, what the agent used, what passed.</p></article>",
        ],
        tr: [
          "      <article class=\"outcome\"><span class=\"step-n\">01 / помнить</span><h3>Сохраняйте то, что узнали.</h3><p>Решения, исправления и находки — со ссылками на код и источник, откуда они взялись.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">02 / находить</span><h3>Возвращайте в нужный момент.</h3><p>Когда задача начинается, Hunch выбирает важную память и доставляет её через MCP или хуки вашего помощника.</p></article>",
          "      <article class=\"outcome\"><span class=\"step-n\">03 / проверять</span><h3>Проверьте и покажите отчёт.</h3><p>Hunch запускает правила, которым вы доверяете, и пишет отчёт о задаче: что он передал, что использовал агент, что прошло проверку.</p></article>",
        ],
      },
      {
        en: [
          "        <h3>Watch a rule hold.</h3>",
          "        <p>An agent reaches for the one thing your team ruled out. The check stops the commit and names the rule.</p>",
        ],
        tr: [
          "        <h3>Посмотрите, как правило остаётся в силе.</h3>",
          "        <p>Агент тянется именно к тому, что ваша команда запретила. Проверка останавливает коммит и называет правило.</p>",
        ],
      },
      {
        en: [
          "          <li>No model in the blocking path</li>",
          "          <li>Cites the rule, the file and the reason</li>",
          "          <li>Runs before a commit and in CI</li>",
        ],
        tr: [
          "          <li>Никакой модели в блокирующем пути</li>",
          "          <li>Указывает правило, файл и причину</li>",
          "          <li>Запускается перед коммитом и в CI</li>",
        ],
      },
      {
        en: [
          "          <div class=\"term-bar\"><i></i><i></i><i></i>&nbsp; ~/acme-checkout<button class=\"replay\" type=\"button\" hidden>Replay</button></div>",
          "          <pre data-typed><span class=\"tl c-key\"># your team's rule: never import lodash — use src/utils</span>",
          "<span class=\"tl c-key\"># an agent just staged:  + import _ from \"lodash\"</span>",
        ],
        tr: [
          "          <div class=\"term-bar\"><i></i><i></i><i></i>&nbsp; ~/acme-checkout<button class=\"replay\" type=\"button\" hidden>Повторить</button></div>",
          "          <pre data-typed><span class=\"tl c-key\"># правило вашей команды: never import lodash — use src/utils</span>",
          "<span class=\"tl c-key\"># агент только что добавил в индекс:  + import _ from \"lodash\"</span>",
        ],
      },
      {
        en: [
          "        <p class=\"demo-note\">Example session; the rule id is illustrative. Run the real one: <a href=\"https://github.com/davesheffer/hunch/blob/main/demo/hunch-blocks-it.sh\">demo/hunch-blocks-it.sh</a></p>",
        ],
        tr: [
          "        <p class=\"demo-note\">Пример сеанса; идентификатор правила условный. Запустите настоящий: <a href=\"https://github.com/davesheffer/hunch/blob/main/demo/hunch-blocks-it.sh\">demo/hunch-blocks-it.sh</a></p>",
        ],
      },
      {
        en: [
          "          <span class=\"eyebrow\">see the evidence</span>",
          "          <h2 id=\"release-proof-title\">Don’t trust the agent. Read the receipt.</h2>",
          "          <p class=\"release-copy\">Every task report keeps apart three things most tools blur together.</p>",
        ],
        tr: [
          "          <span class=\"eyebrow\">смотрите подтверждения</span>",
          "          <h2 id=\"release-proof-title\">Не верьте агенту на слово. Читайте отчёт.</h2>",
          "          <p class=\"release-copy\">В каждом отчёте о задаче раздельно лежат три вещи, которые большинство инструментов смешивает.</p>",
        ],
      },
      {
        en: [
          "      <div class=\"release-metrics\" aria-label=\"What task reports distinguish\">",
          "        <div class=\"release-metric\"><strong>delivered</strong><span>what Hunch handed the agent</span></div>",
          "        <div class=\"release-metric\"><strong>reported</strong><span>what the agent says it used</span></div>",
          "        <div class=\"release-metric\"><strong>checked</strong><span>what rules and commands actually ran</span></div>",
        ],
        tr: [
          "      <div class=\"release-metrics\" aria-label=\"Что различают отчёты о задачах\">",
          "        <div class=\"release-metric\"><strong>передано</strong><span>что Hunch передал агенту</span></div>",
          "        <div class=\"release-metric\"><strong>заявлено</strong><span>что агент, по его словам, использовал</span></div>",
          "        <div class=\"release-metric\"><strong>проверено</strong><span>какие правила и команды реально выполнялись</span></div>",
        ],
      },
      {
        en: [
          "      <p class=\"release-caveat\">A green test alone doesn’t prove Hunch helped. No evidence, no claim: it stays unverified. <a href=\"/docs#task-reports\">Read a task report →</a></p>",
        ],
        tr: [
          "      <p class=\"release-caveat\">Один зелёный тест не доказывает, что помог Hunch. Нет свидетельств — нет заявления: результат остаётся непроверенным. <a href=\"/docs#task-reports\">Читать отчёт о задаче →</a></p>",
        ],
      },
      {
        en: [
          "        <span class=\"eyebrow\">new in 1.52</span>",
          "        <h2>What’s new in Hunch.</h2>",
        ],
        tr: [
          "        <span class=\"eyebrow\">новое в 1.52</span>",
          "        <h2>Что нового в Hunch.</h2>",
        ],
      },
      {
        en: [
          "      <p>The headlines from the last few releases. The rest is in the <a href=\"/ru/changelog\">changelog</a>.</p>",
        ],
        tr: [
          "      <p>Главное из последних релизов. Остальное — в <a href=\"/ru/changelog\">истории изменений</a>.</p>",
        ],
      },
      {
        en: [
          "        <h3>Your repo’s memory, in your browser.</h3>",
          "        <p>Browse, search, edit, link, remove and restore records in a local web UI. It runs on your machine, and only your click writes memory.</p>",
        ],
        tr: [
          "        <h3>Память репозитория — в вашем браузере.</h3>",
          "        <p>Просматривайте, ищите, редактируйте, связывайте, удаляйте и восстанавливайте записи в локальном веб-интерфейсе. Он работает на вашей машине, и в память пишет только ваш клик.</p>",
        ],
      },
      {
        en: [
          "        <h3>A review queue for what needs a person.</h3>",
          "        <p>Deliberate ranks conflicts, stale links, duplicates and weak memory. Grill me questions a record, up to five questions, with secret-looking files withheld.</p>",
        ],
        tr: [
          "        <h3>Очередь на проверку для того, что требует человека.</h3>",
          "        <p>Deliberate ранжирует конфликты, устаревшие связи, дубликаты и слабую память. Grill me задаёт вопросы по записи, не более пяти, и не раскрывает файлы, похожие на секреты.</p>",
        ],
      },
      {
        en: [
          "        <h3>Elixir joins the graph.</h3>",
          "        <p>Blast radius, dependents and rule checks now work on Elixir, next to TypeScript, JavaScript, Python, Go and PHP. Static analysis, no LLM.</p>",
        ],
        tr: [
          "        <h3>Elixir теперь в графе.</h3>",
          "        <p>Область влияния, зависимые элементы и проверки правил теперь работают для Elixir — наряду с TypeScript, JavaScript, Python, Go и PHP. Статический анализ, без LLM.</p>",
        ],
      },
      {
        en: [
          "        <h3>Write the rule in your docs. Hunch enforces it.</h3>",
          "        <p>Mark a sentence with <code>&lt;!-- hunch:rule scope=… --&gt;</code> and it becomes a constraint. <code>--check</code> fails CI when doc and graph disagree.</p>",
        ],
        tr: [
          "        <h3>Напишите правило в документации. Hunch обеспечит его соблюдение.</h3>",
          "        <p>Пометьте предложение с помощью <code>&lt;!-- hunch:rule scope=… --&gt;</code>, и оно станет ограничением. <code>--check</code> проваливает CI, когда документ и граф расходятся.</p>",
        ],
      },
      {
        en: [
          "        <h3>Run only the tests a change needs.</h3>",
          "        <p>Hunch picks the tests that import or ran the changed code. Doubt means more tests: a change it can’t trace runs the full suite.</p>",
        ],
        tr: [
          "        <h3>Запускайте только те тесты, которые нужны изменению.</h3>",
          "        <p>Hunch выбирает тесты, которые импортируют изменённый код или выполняли его. Сомнение — значит больше тестов: если изменение не удаётся отследить, запускается весь набор.</p>",
        ],
      },
      {
        en: [
          "        <h3>Hooks that stay out of your way.</h3>",
        ],
        tr: [
          "        <h3>Хуки, которые не мешают.</h3>",
        ],
      },
      {
        en: [
          "          <caption class=\"sr-only\">Median hook time before and after 1.51.0, in milliseconds</caption>",
        ],
        tr: [
          "          <caption class=\"sr-only\">Медианное время хуков до и после 1.51.0, в миллисекундах</caption>",
        ],
      },
      {
        en: [
          "            <tr><th scope=\"row\">When a task stops</th><td>2174 → <b>298 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Before an edit</th><td>500 → <b>334 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Per prompt</th><td>299 → <b>213 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Session start</th><td>251 → <b>148 ms</b></td></tr>",
        ],
        tr: [
          "            <tr><th scope=\"row\">При остановке задачи</th><td>2174 → <b>298 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Перед правкой</th><td>500 → <b>334 ms</b></td></tr>",
          "            <tr><th scope=\"row\">На каждый промпт</th><td>299 → <b>213 ms</b></td></tr>",
          "            <tr><th scope=\"row\">Начало сессии</th><td>251 → <b>148 ms</b></td></tr>",
        ],
      },
      {
        en: [
          "        <p class=\"new-cap\">Median hook time on the benchmark VM, before and after 1.51.0. Hook output is identical.</p>",
        ],
        tr: [
          "        <p class=\"new-cap\">Медианное время хуков на ВМ для бенчмарков, до и после 1.51.0. Вывод хуков идентичен.</p>",
        ],
      },
      {
        en: [
          "        <h3>One memory per repository.</h3>",
          "        <p>Worktrees and extra clones of a repo share one memory home, chosen from the repo’s identity, not the folder you’re in.</p>",
        ],
        tr: [
          "        <h3>Одна память на репозиторий.</h3>",
          "        <p>Worktree и дополнительные клоны репозитория используют одно хранилище памяти, которое выбирается по идентичности репозитория, а не по папке, в которой вы находитесь.</p>",
        ],
      },
      {
        en: [
          "      <summary>Also new since 1.44</summary>",
        ],
        tr: [
          "      <summary>Ещё новое начиная с 1.44</summary>",
        ],
      },
      {
        en: [
          "        <li><span>1.51</span><div><code>hunch log --for &lt;commit&gt;</code> shows which memory led to which feature commit.</div></li>",
          "        <li><span>1.51</span><div><code>hunch mcp</code> answers the handshake in 1.7–3.7 s. With a large overlay on Windows it used to take 28–76 s.</div></li>",
          "        <li><span>1.50</span><div>A correction can retire the rule it reverses. Nothing is deleted.</div></li>",
          "        <li><span>1.50</span><div>When a test run fails, the hook names the past bug it matches.</div></li>",
          "        <li><span>1.48</span><div>Licensed FSL-1.1-ALv2. Each release converts to Apache-2.0 two years after it ships.</div></li>",
          "        <li><span>1.45</span><div><code>hunch init</code> configures only the assistants it finds.</div></li>",
          "        <li><span>1.44</span><div><code>hunch uninstall</code> removes what Hunch installed and keeps your memory.</div></li>",
          "        <li><span>1.44</span><div>Agent writes over MCP can’t change a record a human confirmed.</div></li>",
        ],
        tr: [
          "        <li><span>1.51</span><div><code>hunch log --for &lt;commit&gt;</code> показывает, какая память привела к какому коммиту с новой функцией.</div></li>",
          "        <li><span>1.51</span><div><code>hunch mcp</code> отвечает на рукопожатие за 1,7–3,7 s. С большим оверлеем в Windows раньше на это уходило 28–76 s.</div></li>",
          "        <li><span>1.50</span><div>Исправление может вывести из действия правило, которое оно отменяет. Ничего не удаляется.</div></li>",
          "        <li><span>1.50</span><div>Когда прогон тестов падает, хук называет прошлую ошибку, с которой он совпадает.</div></li>",
          "        <li><span>1.48</span><div>Лицензия FSL-1.1-ALv2. Каждый релиз переходит на Apache-2.0 через два года после выхода.</div></li>",
          "        <li><span>1.45</span><div><code>hunch init</code> настраивает только тех помощников, которых находит.</div></li>",
          "        <li><span>1.44</span><div><code>hunch uninstall</code> удаляет то, что установил Hunch, и сохраняет вашу память.</div></li>",
          "        <li><span>1.44</span><div>Агенты, пишущие через MCP, не могут изменить запись, подтверждённую человеком.</div></li>",
        ],
      },
      {
        en: [
          "        <span class=\"eyebrow\">under the hood</span>",
          "        <h2>Know what a change breaks before you make it.</h2>",
        ],
        tr: [
          "        <span class=\"eyebrow\">под капотом</span>",
          "        <h2>Узнайте, что сломает изменение, до того как внесёте его.</h2>",
        ],
      },
      {
        en: [
          "      <p>Hunch ties each reason to the code’s real dependencies and to the rules your team chose to protect.</p>",
        ],
        tr: [
          "      <p>Hunch связывает каждую причину с реальными зависимостями кода и с правилами, которые ваша команда решила защищать.</p>",
        ],
      },
      {
        en: [
          "      <article class=\"tech-item\"><code class=\"literal\">hunch why</code><h3>Find the reason</h3><p>The decisions, rejected ideas and past bugs behind any file or symbol.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch impact</code><h3>See what depends on it</h3><p>Follow the code’s real connections to everything a change can reach.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch check</code><h3>Guard the rules you trust</h3><p>Flags a change that breaks a trusted rule. Strict mode blocks only where that rule and your assistant allow it.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch conform</code><h3>Check the code keeps its promises</h3><p>For example: does the payment path still check authorization?</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch drift</code><h3>Catch docs that fell behind</h3><p>A doc still pinned to a replaced decision fails <code class=\"literal\">hunch drift</code>, so CI can catch it.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch dna inspect</code><h3>Learn the house style</h3><p>The terms and habits Hunch observed in this repo. Advice only.</p></article>",
        ],
        tr: [
          "      <article class=\"tech-item\"><code class=\"literal\">hunch why</code><h3>Найдите причину</h3><p>Решения, отвергнутые идеи и прошлые ошибки за любым файлом или символом.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch impact</code><h3>Узнайте, что от него зависит</h3><p>Проследите реальные связи в коде до всего, чего может достичь изменение.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch check</code><h3>Защищайте правила, которым доверяете</h3><p>Отмечает изменение, нарушающее доверенное правило. Строгий режим блокирует только там, где это допускают правило и ваш помощник.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch conform</code><h3>Проверьте, что код держит свои обещания</h3><p>Например: проверяет ли путь оплаты по-прежнему полномочия?</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch drift</code><h3>Ловите отставшую документацию</h3><p>Документ, всё ещё привязанный к заменённому решению, не проходит <code class=\"literal\">hunch drift</code>, так что CI может это поймать.</p></article>",
          "      <article class=\"tech-item\"><code class=\"literal\">hunch dna inspect</code><h3>Освойте стиль проекта</h3><p>Термины и привычки, которые Hunch заметил в этом репозитории. Только рекомендации.</p></article>",
        ],
      },
      {
        en: [
          "    <p class=\"tech-link\">Indexes TypeScript, JavaScript, Python, Go, PHP and Elixir, plus Helm, Kustomize and YAML. Beyond code, <code>hunch serve</code> is a self-hosted service that <a href=\"/docs#shared-state\">shares decisions, finished work and open commitments</a> across agents. <a href=\"/docs\">Read the docs →</a></p>",
        ],
        tr: [
          "    <p class=\"tech-link\">Индексирует TypeScript, JavaScript, Python, Go, PHP и Elixir, а также Helm, Kustomize и YAML. Помимо кода, <code>hunch serve</code> — это сервис, который вы размещаете у себя и который <a href=\"/docs#shared-state\">передаёт решения, выполненную работу и открытые обязательства</a> между агентами. <a href=\"/docs\">Читать документацию →</a></p>",
        ],
      },
      {
        en: [
          "      <span class=\"eyebrow\">get started</span>",
          "      <h2>Start in one repository.</h2>",
          "      <p>Needs Node 22.13+ and a Git repository. No Hunch account.</p>",
        ],
        tr: [
          "      <span class=\"eyebrow\">начало работы</span>",
          "      <h2>Начните с одного репозитория.</h2>",
          "      <p>Нужны Node 22.13+ и Git-репозиторий. Аккаунт Hunch не нужен.</p>",
        ],
      },
      {
        en: [
          "          <div class=\"step\"><span class=\"step-n\">01</span><div><h3>Install and connect</h3><p>Install the CLI, then run <code>hunch init</code> in your project. It sets up only the assistants you have.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">02</span><div><h3>Teach it your history</h3><p>Optional: draft memory from the last 90 days of Git, then review what it captured.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">03</span><div><h3>Ask why</h3><p>Reload your assistant and ask why a file is built this way. Using Codex? Trust the hooks in <code>/hooks</code> first.</p></div></div>",
        ],
        tr: [
          "          <div class=\"step\"><span class=\"step-n\">01</span><div><h3>Установите и подключите</h3><p>Установите CLI и запустите <code>hunch init</code> в своём проекте. Он настроит только тех помощников, которые у вас есть.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">02</span><div><h3>Расскажите ему свою историю</h3><p>По желанию: составьте черновик памяти по последним 90 дням Git и проверьте, что он записал.</p></div></div>",
          "          <div class=\"step\"><span class=\"step-n\">03</span><div><h3>Спросите, почему</h3><p>Перезапустите помощника и спросите, почему файл устроен именно так. Используете Codex? Сначала доверьте хуки в <code>/hooks</code>.</p></div></div>",
        ],
      },
      {
        en: [
          "        <div class=\"prov\" role=\"group\" aria-label=\"Supported assistants\">",
          "          <span>Claude Code</span><span>Codex</span><span>Cursor</span><span>VS Code / Copilot</span><span>Windsurf</span><span>Antigravity</span><span>any MCP client</span>",
        ],
        tr: [
          "        <div class=\"prov\" role=\"group\" aria-label=\"Поддерживаемые помощники\">",
          "          <span>Claude Code</span><span>Codex</span><span>Cursor</span><span>VS Code / Copilot</span><span>Windsurf</span><span>Antigravity</span><span>любой MCP-клиент</span>",
        ],
      },
      {
        en: [
          "          <pre style=\"min-height:0\"><span class=\"c-key\"># install from npm</span>",
        ],
        tr: [
          "          <pre style=\"min-height:0\"><span class=\"c-key\"># установка из npm</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># connect Hunch to this project</span>",
        ],
        tr: [
          "<span class=\"c-key\"># подключить Hunch к проекту и помощникам</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># learn from the last 90 days</span>",
        ],
        tr: [
          "<span class=\"c-key\"># при желании изучить последние 90 дней</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># ask what a file is for</span>",
        ],
        tr: [
          "<span class=\"c-key\"># спросить, зачем нужен файл</span>",
        ],
      },
      {
        en: [
          "<span class=\"c-key\"># browse your memory in the browser</span>",
        ],
        tr: [
          "<span class=\"c-key\"># просмотреть память в браузере</span>",
        ],
      },
      {
        en: [
          "          <button class=\"copybtn\" type=\"button\" data-clip=\"#install-cmd\" data-clip-done=\"Copied\"><svg class=\"clip-ico\" viewBox=\"0 0 16 16\" aria-hidden=\"true\" focusable=\"false\"><g class=\"ico-copy\"><rect x=\"5.5\" y=\"5.5\" width=\"8\" height=\"8\" rx=\"1.6\"/><path d=\"M10.5 3.5v-.4a1.6 1.6 0 0 0-1.6-1.6H3.1a1.6 1.6 0 0 0-1.6 1.6v5.8a1.6 1.6 0 0 0 1.6 1.6h.4\"/></g><path class=\"ico-check\" d=\"M3 8.6l3.2 3.2L13 4.9\"/></svg><span class=\"clip-label\">Copy</span></button>",
        ],
        tr: [
          "          <button class=\"copybtn\" type=\"button\" data-clip=\"#install-cmd\" data-clip-done=\"Скопировано\"><svg class=\"clip-ico\" viewBox=\"0 0 16 16\" aria-hidden=\"true\" focusable=\"false\"><g class=\"ico-copy\"><rect x=\"5.5\" y=\"5.5\" width=\"8\" height=\"8\" rx=\"1.6\"/><path d=\"M10.5 3.5v-.4a1.6 1.6 0 0 0-1.6-1.6H3.1a1.6 1.6 0 0 0-1.6 1.6v5.8a1.6 1.6 0 0 0 1.6 1.6h.4\"/></g><path class=\"ico-check\" d=\"M3 8.6l3.2 3.2L13 4.9\"/></svg><span class=\"clip-label\">Копировать</span></button>",
        ],
      },
      {
        en: [
          "          <li>Advice by default. Nothing blocks until you say so.</li>",
          "          <li>Update with <code>hunch update</code>. Leave with <code>hunch uninstall</code>: it removes what Hunch installed and keeps your memory.</li>",
          "          <li>Claude Code? Install as a plugin: <code>/plugin marketplace add davesheffer/hunch</code> → <code>/plugin install hunch@hunch</code></li>",
          "          <li>VS Code? <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">Get the extension on Open VSX</a></li>",
        ],
        tr: [
          "          <li>По умолчанию — только рекомендации. Ничто не блокируется, пока вы сами этого не решите.</li>",
          "          <li>Обновление — <code>hunch update</code>. Уйти — <code>hunch uninstall</code>: он удаляет то, что установил Hunch, и сохраняет вашу память.</li>",
          "          <li>Используете Claude Code? Установите плагин: <code>/plugin marketplace add davesheffer/hunch</code> → <code>/plugin install hunch@hunch</code></li>",
          "          <li>VS Code? <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">Установите расширение из Open VSX</a></li>",
        ],
      },
      {
        en: [
          "    <h2>Stop re-explaining your codebase.</h2>",
          "    <p>Give every agent the same memory and every change the same check. It advises by default, and one command removes it.</p>",
        ],
        tr: [
          "    <h2>Хватит заново объяснять свою кодовую базу.</h2>",
          "    <p>Дайте каждому агенту одну и ту же память, а каждому изменению — одну и ту же проверку. По умолчанию Hunch только советует, а удаляется одной командой.</p>",
        ],
      },
      {
        en: [
          "      <a class=\"btn\" href=\"#start\">Get started</a>",
          "      <a class=\"btn ghost\" href=\"/docs\">Read the docs</a>",
        ],
        tr: [
          "      <a class=\"btn\" href=\"#start\">Начать</a>",
          "      <a class=\"btn ghost\" href=\"/docs\">Читать документацию</a>",
        ],
      },
      {
        en: [
          "      <p class=\"about\">Hunch keeps the why behind your code, in Git, for every assistant you use.</p>",
          "      <p class=\"about\">FSL-1.1-ALv2. Use it for your own work, internal or commercial. Each release becomes Apache-2.0 two years after it ships.</p>",
        ],
        tr: [
          "      <p class=\"about\">Hunch хранит причины, стоящие за вашим кодом, в Git — для каждого помощника, которым вы пользуетесь.</p>",
          "      <p class=\"about\">FSL-1.1-ALv2. Используйте в собственной работе, внутренней или коммерческой. Каждый релиз становится Apache-2.0 через два года после выхода.</p>",
        ],
      },
      {
        en: [
          "      <h4>product</h4>",
          "      <a href=\"#how\">How it works</a>",
          "      <a href=\"#new\">What’s new</a>",
          "      <a href=\"#inside\">Under the hood</a>",
        ],
        tr: [
          "      <h4>продукт</h4>",
          "      <a href=\"#how\">Как это работает</a>",
          "      <a href=\"#new\">Что нового</a>",
          "      <a href=\"#inside\">Что внутри</a>",
        ],
      },
      {
        en: [
          "      <a href=\"/ru/changelog\">Changelog</a>",
        ],
        tr: [
          "      <a href=\"/ru/changelog\">История изменений</a>",
        ],
      },
      {
        en: [
          "      <h4>develop</h4>",
          "      <a href=\"#start\">Get started</a>",
          "      <a href=\"/docs\">Docs</a>",
          "      <a href=\"/docs#mcp\">MCP tools</a>",
          "      <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">VS Code extension</a>",
        ],
        tr: [
          "      <h4>разработка</h4>",
          "      <a href=\"#start\">Начать</a>",
          "      <a href=\"/docs\">Документация</a>",
          "      <a href=\"/docs#mcp\">Инструменты MCP</a>",
          "      <a href=\"https://open-vsx.org/extension/davesheffer/hunch-vscode\">Расширение VS Code</a>",
        ],
      },
      {
        en: [
          "      <h4>connect</h4>",
        ],
        tr: [
          "      <h4>ссылки</h4>",
        ],
      },
      {
        en: [
          "      <a href=\"/ru/blog\">Blog</a>",
        ],
        tr: [
          "      <a href=\"/ru/blog\">Блог</a>",
        ],
      },
      {
        en: [
          "    const RECEIPTS = [\"dec_8b2e · held\", \"dec_a466 · held\", \"dec_e0a3 · held\", \"dec_fd36 · held\"];",
          "    const BLOCKS = [\"con_9027 · blocked\", \"con_2ce3 · blocked\"];",
        ],
        tr: [
          "    const RECEIPTS = [\"dec_8b2e · сохранено\", \"dec_a466 · сохранено\", \"dec_e0a3 · сохранено\", \"dec_fd36 · сохранено\"];",
          "    const BLOCKS = [\"con_9027 · заблокировано\", \"con_2ce3 · заблокировано\"];",
        ],
      },
      {
        en: [
          "      { label: \"decision\", angle: -2.55 },",
          "      { label: \"bug\", angle: -0.18 },",
          "      { label: \"rule\", angle: 1.72 },",
        ],
        tr: [
          "      { label: \"решение\", angle: -2.55 },",
          "      { label: \"ошибка\", angle: -0.18 },",
          "      { label: \"правило\", angle: 1.72 },",
        ],
      },
      {
        en: [
          "      ctx.fillText(\"why\", x, y + 0.5);",
        ],
        tr: [
          "      ctx.fillText(\"почему\", x, y + 0.5);",
        ],
      },
      {
        en: [
          "        ctx.fillText(\"reason recalled before edit\", x, y + r + 34);",
        ],
        tr: [
          "        ctx.fillText(\"причина найдена до правки\", x, y + r + 34);",
        ],
      },
    ],
  },
};
