// ═══════════════════════════════════════════════════════════════════════════
// دالة مشتركة بين fetch() و scheduled() — نفس حساب رقم الأسبوع في كل مكان
// تحسب عدد الأسابيع منذ 1 يناير من السنة الحالية
// ═══════════════════════════════════════════════════════════════════════════
function getCurrentWeek() {
  const now   = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  return Math.floor((now - start) / (1000 * 60 * 60 * 24 * 7));
}

// ═══════════════════════════════════════════════════════════════════════════
// دالة مساعدة: تبني جملة NOT IN بشكل آمن
// لو usedList فارغ ترجع شرطاً دائم الصحة لتجنب SQL خاطئ
// ═══════════════════════════════════════════════════════════════════════════
function buildNotIn(usedList) {
  if (!usedList || usedList.length === 0) return { clause: '1=1', params: [] };
  return {
    clause: `username NOT IN (${usedList.map(() => '?').join(',')})`,
    params: usedList
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    };

    // معالجة CORS preflight
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    // ─────────────────────────────────────────────────────────────────────
    // دالة: تنظيف والتحقق من اسم المستخدم
    // ─────────────────────────────────────────────────────────────────────
    function sanitizeAndValidate(raw) {
      if (!raw || typeof raw !== 'string') return { error: 'اسم غير صالح' };
      const clean = raw.trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.]/g, '')
        .replace(/^\.+/, '')
        .replace(/\.{2,}/g, '.')
        .replace(/\.+$/, '');
      if (clean.length < 2)   return { error: 'الاسم قصير جداً (2-24 حرف)' };
      if (clean.length > 24)  return { error: 'الاسم طويل جداً (2-24 حرف)' };
      if (!/[a-z]/.test(clean)) return { error: 'الاسم يجب أن يبدأ بحرف' };
      return { clean };
    }

    // ─────────────────────────────────────────────────────────────────────
    // دالة: تعليم المستخدمين غير النشطين منذ 7 أيام كمحذوفين (soft delete)
    // ─────────────────────────────────────────────────────────────────────
    async function checkAndDeleteInactiveUsers(env) {
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare(
          'UPDATE users SET is_deleted = 1 WHERE last_active < ? AND is_deleted = 0'
        ).bind(sevenDaysAgo).run();
      } catch (err) {
        console.error('checkAndDeleteInactiveUsers error:', err);
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // دالة: تحديث آخر نشاط للمستخدم
    // ─────────────────────────────────────────────────────────────────────
    async function updateLastActive(username, env) {
      try {
        await env.DB.prepare(
          'UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE username = ?'
        ).bind(username).run();
      } catch (err) {
        console.error('updateLastActive error:', err);
      }
    }

    // =========================================================================
    // GET /api/check — هل اسم المستخدم موجود؟
    // =========================================================================
    if (url.pathname === '/api/check' && request.method === 'GET') {
      try {
        const raw    = url.searchParams.get('username');
        const result = sanitizeAndValidate(raw);
        if (result.error)
          return new Response(JSON.stringify({ exists: false }), { headers });

        const user = await env.DB.prepare(
          'SELECT 1 FROM users WHERE username = ? AND is_deleted = 0'
        ).bind(result.clean).first();

        return new Response(JSON.stringify({ exists: !!user }), { headers });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'خطأ في الخادم' }), { status: 500, headers });
      }
    }

    // =========================================================================
    // GET /api/targets — قائمة الـ 5 متابعات بالخوارزمية الذكية
    //
    // الخوارزمية:
    //   #1 → أعلى ذهبية أسبوعية  (لو الكل صفر → عشوائي)
    //   #2 → أعلى فضية أسبوعية   (غير #1، لو الكل صفر → عشوائي)
    //   #3 → عشوائي من أعلى 25% فضية (مع fallback عشوائي لو فشل)
    //   #4 → عشوائي من منطقة 25%-75% فضية (مع fallback عشوائي لو فشل)
    //   #5 → أحدث مستخدم مسجل    (مع fallback عشوائي لو فشل)
    //
    // ضمانات:
    //   - لا تكرار في أي حالة
    //   - يعمل مع 1 مستخدم وما فوق
    //   - يعمل لو الكل عنده 0 نقاط
    //   - fallback عشوائي في كل مرحلة لو لم يجد مناسباً
    // =========================================================================
    if (url.pathname === '/api/targets' && request.method === 'GET') {
      try {
        await checkAndDeleteInactiveUsers(env);

        // رقم الأسبوع الحالي — تُستخدم لقراءة نقاط هذا الأسبوع فقط من weekly_leaderboard
        // (بدلاً من عمودي users.gold_points_weekly/silver_points_weekly القديمين)
        const currentWeek = getCurrentWeek();

        // عد المستخدمين النشطين
        const totalCount = await env.DB.prepare(
          'SELECT COUNT(*) as total FROM users WHERE is_deleted = 0'
        ).first();
        const total = totalCount.total;

        // حساب الوقت المتبقي لنهاية الأسبوع
        const now           = new Date();
        const nextWeekStart = new Date(now);
        nextWeekStart.setDate(nextWeekStart.getDate() + (7 - nextWeekStart.getDay()));
        nextWeekStart.setHours(0, 0, 0, 0);
        const msLeft   = Math.max(0, nextWeekStart - now);
        const daysLeft = Math.floor(msLeft / (24 * 60 * 60 * 1000));
        const hoursLeft= Math.floor((msLeft % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

        // حالة: قاعدة فارغة تماماً
        if (total === 0) {
          return new Response(JSON.stringify({
            targets: [],
            isEmpty: true,
            topGold: null,
            topSilver: null,
            daysLeft,
            hoursLeft
          }), { headers });
        }

        let finalTargets = [];
        let used         = new Set();

        // ── دالة مساعدة داخلية: جلب مستخدم عشوائي من المتاحين ──────────────
        // تُستخدم كـ fallback في كل مرحلة
        async function getRandomFallback() {
          if (used.size >= total) return null;
          const { clause, params } = buildNotIn([...used]);
          return await env.DB.prepare(
            `SELECT u.username,
                    COALESCE(w.gold_points, 0)   AS gold_points_weekly,
                    COALESCE(w.silver_points, 0) AS silver_points_weekly
             FROM users u
             LEFT JOIN weekly_leaderboard w
               ON w.username = u.username AND w.week_number = ?
             WHERE u.is_deleted = 0 AND ${clause}
             ORDER BY RANDOM()
             LIMIT 1`
          ).bind(currentWeek, ...params).first();
        }

        // ── #1: أعلى ذهبية ───────────────────────────────────────────────────
        // لو الكل عنده 0 ذهبية → نأخذ عشوائياً (RANDOM() كـ tiebreaker)
        let rank1User = await env.DB.prepare(
          `SELECT u.username,
                  COALESCE(w.gold_points, 0)   AS gold_points_weekly,
                  COALESCE(w.silver_points, 0) AS silver_points_weekly
           FROM users u
           LEFT JOIN weekly_leaderboard w
             ON w.username = u.username AND w.week_number = ?
           WHERE u.is_deleted = 0
           ORDER BY gold_points_weekly DESC, RANDOM()
           LIMIT 1`
        ).bind(currentWeek).first();

        if (rank1User) {
          finalTargets.push(rank1User);
          used.add(rank1User.username);
        }

        // ── #2: أعلى فضية (غير #1) ──────────────────────────────────────────
        // لو الكل عنده 0 فضية → RANDOM() كـ tiebreaker
        let rank2User = null;
        if (used.size < total) {
          const { clause, params } = buildNotIn([...used]);
          rank2User = await env.DB.prepare(
            `SELECT u.username,
                    COALESCE(w.gold_points, 0)   AS gold_points_weekly,
                    COALESCE(w.silver_points, 0) AS silver_points_weekly
             FROM users u
             LEFT JOIN weekly_leaderboard w
               ON w.username = u.username AND w.week_number = ?
             WHERE u.is_deleted = 0 AND ${clause}
             ORDER BY silver_points_weekly DESC, RANDOM()
             LIMIT 1`
          ).bind(currentWeek, ...params).first();
        }

        if (rank2User) {
          finalTargets.push(rank2User);
          used.add(rank2User.username);
        }

        // ── #3: عشوائي من أعلى 25% فضية ────────────────────────────────────
        // الـ 25% تُحسب من المستخدمين المتاحين (غير المستخدمين في #1 و #2)
        // fallback: عشوائي كامل لو المنطقة فارغة أو صغيرة جداً
        let rank3User = null;
        if (used.size < total) {
          const available = total - used.size;
          // حجم منطقة الـ 25% من المتاحين (حد أدنى 1)
          const zone25Size = Math.max(1, Math.ceil(available * 0.25));
          // OFFSET عشوائي داخل المنطقة
          const offset25   = Math.floor(Math.random() * zone25Size);
          const { clause, params } = buildNotIn([...used]);

          rank3User = await env.DB.prepare(
            `SELECT u.username,
                    COALESCE(w.gold_points, 0)   AS gold_points_weekly,
                    COALESCE(w.silver_points, 0) AS silver_points_weekly
             FROM users u
             LEFT JOIN weekly_leaderboard w
               ON w.username = u.username AND w.week_number = ?
             WHERE u.is_deleted = 0 AND ${clause}
             ORDER BY silver_points_weekly DESC
             LIMIT 1 OFFSET ?`
          ).bind(currentWeek, ...params, offset25).first();

          // fallback: لو OFFSET خرج فارغاً → عشوائي من المتاحين
          if (!rank3User) rank3User = await getRandomFallback();
        }

        if (rank3User) {
          finalTargets.push(rank3User);
          used.add(rank3User.username);
        }

        // ── #4: عشوائي من منطقة 25%-75% فضية ──────────────────────────────
        // نحسب المنطقة من المستخدمين المتاحين بعد استبعاد #1 و #2 و #3
        // fallback: عشوائي كامل لو المنطقة لا تحتوي أحداً
        let rank4User = null;
        if (used.size < total) {
          const available   = total - used.size;
          const zone25Count = Math.max(1, Math.ceil(available * 0.25));
          const zone75Count = Math.max(1, Math.ceil(available * 0.75));
          // المنطقة الوسطى: من نهاية الـ25% إلى نهاية الـ75%
          const zoneSize    = Math.max(0, zone75Count - zone25Count);
          const { clause, params } = buildNotIn([...used]);

          if (zoneSize > 0) {
            const offset75 = zone25Count + Math.floor(Math.random() * zoneSize);
            rank4User = await env.DB.prepare(
              `SELECT u.username,
                      COALESCE(w.gold_points, 0)   AS gold_points_weekly,
                      COALESCE(w.silver_points, 0) AS silver_points_weekly
               FROM users u
               LEFT JOIN weekly_leaderboard w
                 ON w.username = u.username AND w.week_number = ?
               WHERE u.is_deleted = 0 AND ${clause}
               ORDER BY silver_points_weekly DESC
               LIMIT 1 OFFSET ?`
            ).bind(currentWeek, ...params, offset75).first();
          }

          // fallback: لو المنطقة فارغة أو OFFSET خرج null → عشوائي
          if (!rank4User) rank4User = await getRandomFallback();
        }

        if (rank4User) {
          finalTargets.push(rank4User);
          used.add(rank4User.username);
        }

        // ── #5: أحدث مستخدم مسجل ────────────────────────────────────────────
        // مكافأة للجدد — يشوفون أنفسهم في القائمة فيبقون
        // fallback: عشوائي لو أحدث مستخدم موجود مسبقاً في القائمة
        let rank5User = null;
        if (used.size < total) {
          const { clause, params } = buildNotIn([...used]);
          rank5User = await env.DB.prepare(
            `SELECT u.username,
                    COALESCE(w.gold_points, 0)   AS gold_points_weekly,
                    COALESCE(w.silver_points, 0) AS silver_points_weekly
             FROM users u
             LEFT JOIN weekly_leaderboard w
               ON w.username = u.username AND w.week_number = ?
             WHERE u.is_deleted = 0 AND ${clause}
             ORDER BY u.created_at DESC
             LIMIT 1`
          ).bind(currentWeek, ...params).first();

          // fallback: لو أحدث مستخدم مسبقاً مستخدم → عشوائي
          if (!rank5User) rank5User = await getRandomFallback();
        }

        if (rank5User) {
          finalTargets.push(rank5User);
          used.add(rank5User.username);
        }

        return new Response(JSON.stringify({
          targets:   finalTargets,
          isEmpty:   false,
          total,
          topGold:   rank1User  || null,
          topSilver: rank2User  || null,
          daysLeft,
          hoursLeft
        }), { headers });

      } catch (err) {
        console.error('targets error:', err);
        return new Response(JSON.stringify({ error: 'خطأ في الخادم' }), { status: 500, headers });
      }
    }

    // =========================================================================
    // POST /api/register — تسجيل مستخدم جديد
    // =========================================================================
    if (url.pathname === '/api/register' && request.method === 'POST') {
      try {
        let body;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: 'طلب غير صالح' }), { status: 400, headers });
        }

        const { username, ref, turnstileToken } = body;

        // التحقق من وجود Turnstile token
        if (!turnstileToken)
          return new Response(JSON.stringify({ error: 'التحقق مطلوب' }), { status: 400, headers });

        if (!env.TURNSTILE_SECRET)
          return new Response(JSON.stringify({ error: 'خطأ في الإعدادات' }), { status: 500, headers });

        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

        // رقم الأسبوع الحالي — يُستخدم لتسجيل نقاط الإحالة في weekly_leaderboard
        // (بدلاً من عمود users.gold_points_weekly القديم الذي كان يحتاج تصفيراً أسبوعياً)
        const currentWeek = getCurrentWeek();

        // التحقق من Turnstile مع Cloudflare
        try {
          const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: turnstileToken, remoteip: ip })
          });
          const verifyData = await verifyRes.json();
          if (!verifyData.success)
            return new Response(JSON.stringify({ error: 'فشل التحقق' }), { status: 403, headers });
        } catch (err) {
          console.error('Turnstile error:', err);
          return new Response(JSON.stringify({ error: 'خطأ في التحقق' }), { status: 500, headers });
        }

        // تنظيف والتحقق من الاسم
        const validation = sanitizeAndValidate(username);
        if (validation.error)
          return new Response(JSON.stringify({ error: validation.error }), { status: 400, headers });

        const clean  = validation.clean;
        const banned = ['admin', 'root', 'null', 'undefined', 'support', 'tiktok', 'test'];
        if (banned.includes(clean))
          return new Response(JSON.stringify({ error: 'اسم غير مسموح' }), { status: 400, headers });

        // التحقق من وجود المستخدم مسبقاً
        const existingUser = await env.DB.prepare(
          'SELECT username, is_deleted FROM users WHERE username = ?'
        ).bind(clean).first();

        if (existingUser) {
          // المستخدم موجود ونشط
          if (existingUser.is_deleted === 0)
            return new Response(JSON.stringify({ error: 'سجلت بالفعل' }), { status: 400, headers });

          // المستخدم محذوف سابقاً → استعادة حسابه
          let confirmedRef = null;
          if (ref) {
            const refV = sanitizeAndValidate(ref);
            if (!refV.error && refV.clean !== clean) {
              const refExists = await env.DB.prepare(
                'SELECT 1 FROM users WHERE username = ? AND is_deleted = 0'
              ).bind(refV.clean).first();
              if (refExists) confirmedRef = refV.clean;
            }
          }

          await env.DB.batch([
            env.DB.prepare(
              'UPDATE users SET is_deleted = 0, last_active = CURRENT_TIMESTAMP, referred_by = ? WHERE username = ?'
            ).bind(confirmedRef, clean),
            // المجموع الكلي (all-time) يبقى في جدول users كما هو — لا يُصفَّر أبداً
            ...(confirmedRef ? [env.DB.prepare(
              'UPDATE users SET total_gold_all_time = total_gold_all_time + 1 WHERE username = ?'
            ).bind(confirmedRef)] : []),
            // نقطة الأسبوع الحالي تُكتب في weekly_leaderboard فقط —
            // صف جديد لو أول نقطة هذا الأسبوع، أو تحديث لو موجود بالفعل
            // لا حاجة لأي "تصفير" لاحقاً لأن كل أسبوع له صف مستقل تلقائياً
            ...(confirmedRef ? [env.DB.prepare(
              `INSERT INTO weekly_leaderboard (username, week_number, gold_points, silver_points)
               VALUES (?, ?, 1, 0)
               ON CONFLICT(username, week_number) DO UPDATE SET gold_points = gold_points + 1`
            ).bind(confirmedRef, currentWeek)] : [])
          ]);

          return new Response(JSON.stringify({ success: true, restored: true }), { headers });
        }

        // حد 3 تسجيلات لكل IP يومياً
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const attempts = await env.DB.prepare(
          'SELECT COUNT(*) as total FROM users WHERE ip = ? AND created_at >= ? AND is_deleted = 0'
        ).bind(ip, today.toISOString()).first();

        if (attempts.total >= 3)
          return new Response(JSON.stringify({ error: 'حد أقصى 3 تسجيلات يومياً' }), { status: 429, headers });

        // التحقق من صحة رابط الإحالة
        let confirmedRef = null;
        if (ref) {
          const refV = sanitizeAndValidate(ref);
          if (!refV.error && refV.clean !== clean) {
            const refExists = await env.DB.prepare(
              'SELECT 1 FROM users WHERE username = ? AND is_deleted = 0'
            ).bind(refV.clean).first();
            if (refExists) confirmedRef = refV.clean;
          }
        }

        // إدخال المستخدم الجديد + منح نقطة للمُحيل
        await env.DB.batch([
          env.DB.prepare(
            'INSERT INTO users (username, referred_by, ip, is_deleted) VALUES (?, ?, ?, 0)'
          ).bind(clean, confirmedRef, ip),
          // المجموع الكلي (all-time) في جدول users — لا يُصفَّر أبداً
          ...(confirmedRef ? [env.DB.prepare(
            'UPDATE users SET total_gold_all_time = total_gold_all_time + 1 WHERE username = ?'
          ).bind(confirmedRef)] : []),
          // نقطة الأسبوع الحالي في weekly_leaderboard — بدون أي حاجة للتصفير لاحقاً
          ...(confirmedRef ? [env.DB.prepare(
            `INSERT INTO weekly_leaderboard (username, week_number, gold_points, silver_points)
             VALUES (?, ?, 1, 0)
             ON CONFLICT(username, week_number) DO UPDATE SET gold_points = gold_points + 1`
          ).bind(confirmedRef, currentWeek)] : [])
        ]);

        // إنشاء تحدي أسبوعي للمستخدم الجديد (3 أشخاص عشوائيين)
        const allUsers = await env.DB.prepare(
          'SELECT username FROM users WHERE username != ? AND is_deleted = 0 ORDER BY RANDOM() LIMIT 3'
        ).bind(clean).all();

        const targetUsernames = allUsers.results.map(u => u.username);

        if (targetUsernames.length > 0) {
          await env.DB.prepare(
            'INSERT INTO weekly_challenges (username, challenge_targets, completed_targets, claimed, week_number) VALUES (?, ?, ?, 0, ?)'
          ).bind(clean, JSON.stringify(targetUsernames), JSON.stringify([]), currentWeek).run();
        }

        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (err) {
        console.error('Register error:', err);
        return new Response(JSON.stringify({ error: 'خطأ في التسجيل' }), { status: 500, headers });
      }
    }

    // =========================================================================
    // GET /api/user-stats — إحصائيات المستخدم
    // =========================================================================
    if (url.pathname === '/api/user-stats' && request.method === 'GET') {
      try {
        const username = url.searchParams.get('username');
        if (!username)
          return new Response(JSON.stringify({ error: 'اسم مطلوب' }), { status: 400, headers });

        const validation = sanitizeAndValidate(username);
        if (validation.error)
          return new Response(JSON.stringify({ error: validation.error }), { status: 400, headers });

        await updateLastActive(validation.clean, env);

        const currentWeek = getCurrentWeek();
        const user = await env.DB.prepare(
          `SELECT u.username,
                  COALESCE(w.gold_points, 0)   AS gold_points_weekly,
                  COALESCE(w.silver_points, 0) AS silver_points_weekly,
                  u.total_gold_all_time,
                  u.total_silver_all_time
           FROM users u
           LEFT JOIN weekly_leaderboard w
             ON w.username = u.username AND w.week_number = ?
           WHERE u.username = ? AND u.is_deleted = 0`
        ).bind(currentWeek, validation.clean).first();

        if (!user)
          return new Response(JSON.stringify({ error: 'المستخدم غير موجود' }), { status: 404, headers });

        return new Response(JSON.stringify({
          username:         user.username,
          goldPointsWeekly: user.gold_points_weekly,
          silverPointsWeekly: user.silver_points_weekly,
          totalScoreWeekly:   user.gold_points_weekly + (user.silver_points_weekly * 5),
          totalGoldAllTime:   user.total_gold_all_time,
          totalSilverAllTime: user.total_silver_all_time,
          totalScoreAllTime:  user.total_gold_all_time + (user.total_silver_all_time * 5)
        }), { headers });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'خطأ في الخادم' }), { status: 500, headers });
      }
    }

    // =========================================================================
    // GET /api/challenge — جلب التحدي الأسبوعي للمستخدم
    // =========================================================================
    if (url.pathname === '/api/challenge' && request.method === 'GET') {
      try {
        const username = url.searchParams.get('username');
        if (!username)
          return new Response(JSON.stringify({ error: 'اسم مطلوب' }), { status: 400, headers });

        const validation = sanitizeAndValidate(username);
        if (validation.error)
          return new Response(JSON.stringify({ error: validation.error }), { status: 400, headers });

        await updateLastActive(validation.clean, env);

        const currentWeek = getCurrentWeek();
        const challenge   = await env.DB.prepare(
          'SELECT id, challenge_targets, completed_targets, claimed FROM weekly_challenges WHERE username = ? AND week_number = ? ORDER BY created_at DESC LIMIT 1'
        ).bind(validation.clean, currentWeek).first();

        // لا يوجد تحدي → أنشئ واحداً جديداً
        if (!challenge) {
          const allUsers = await env.DB.prepare(
            'SELECT username FROM users WHERE username != ? AND is_deleted = 0 ORDER BY RANDOM() LIMIT 3'
          ).bind(validation.clean).all();

          const targetUsernames = allUsers.results.map(u => u.username);

          // حالة: لا يوجد مستخدمون آخرون بعد
          if (targetUsernames.length === 0) {
            return new Response(JSON.stringify({
              id: null, targets: [], completed: [], claimed: false, progress: '0/0'
            }), { headers });
          }

          const result = await env.DB.prepare(
            'INSERT INTO weekly_challenges (username, challenge_targets, completed_targets, claimed, week_number) VALUES (?, ?, ?, 0, ?) RETURNING id'
          ).bind(validation.clean, JSON.stringify(targetUsernames), JSON.stringify([]), currentWeek).first();

          return new Response(JSON.stringify({
            id:       result.id,
            targets:  targetUsernames,
            completed:[],
            claimed:  false,
            progress: '0/' + targetUsernames.length
          }), { headers });
        }

        const targets   = JSON.parse(challenge.challenge_targets  || '[]');
        const completed = JSON.parse(challenge.completed_targets   || '[]');

        return new Response(JSON.stringify({
          id:       challenge.id,
          targets,
          completed,
          claimed:  challenge.claimed === 1,
          progress: completed.length + '/' + targets.length
        }), { headers });

      } catch (err) {
        return new Response(JSON.stringify({ error: 'خطأ في الخادم' }), { status: 500, headers });
      }
    }

    // =========================================================================
    // POST /api/challenge/mark — تأشير هدف كمتابَع
    // =========================================================================
    if (url.pathname === '/api/challenge/mark' && request.method === 'POST') {
      try {
        let body;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: 'طلب غير صالح' }), { status: 400, headers });
        }

        const { username, targetUsername } = body;

        const validation = sanitizeAndValidate(username);
        if (validation.error)
          return new Response(JSON.stringify({ error: validation.error }), { status: 400, headers });

        const targetValidation = sanitizeAndValidate(targetUsername);
        if (targetValidation.error)
          return new Response(JSON.stringify({ error: 'هدف غير صالح' }), { status: 400, headers });

        const currentWeek = getCurrentWeek();
        const challenge   = await env.DB.prepare(
          'SELECT id, challenge_targets, completed_targets FROM weekly_challenges WHERE username = ? AND week_number = ? ORDER BY created_at DESC LIMIT 1'
        ).bind(validation.clean, currentWeek).first();

        if (!challenge)
          return new Response(JSON.stringify({ error: 'لا يوجد تحدي' }), { status: 400, headers });

        const targets = JSON.parse(challenge.challenge_targets || '[]');
        if (!targets.includes(targetValidation.clean))
          return new Response(JSON.stringify({ error: 'هدف غير موجود في تحديك' }), { status: 400, headers });

        const completed = JSON.parse(challenge.completed_targets || '[]');

        // تجنب التكرار: لو مؤشر مسبقاً لا نكتب مجدداً
        if (!completed.includes(targetValidation.clean)) {
          completed.push(targetValidation.clean);
          await env.DB.prepare(
            'UPDATE weekly_challenges SET completed_targets = ? WHERE id = ?'
          ).bind(JSON.stringify(completed), challenge.id).run();
        }

        return new Response(JSON.stringify({
          success:  true,
          progress: completed.length + '/' + targets.length
        }), { headers });

      } catch (err) {
        return new Response(JSON.stringify({ error: 'خطأ في الخادم' }), { status: 500, headers });
      }
    }

    // =========================================================================
    // POST /api/challenge/claim — استلام مكافأة التحدي (+5 فضية)
    // =========================================================================
    if (url.pathname === '/api/challenge/claim' && request.method === 'POST') {
      try {
        let body;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: 'طلب غير صالح' }), { status: 400, headers });
        }

        const { username } = body;

        const validation = sanitizeAndValidate(username);
        if (validation.error)
          return new Response(JSON.stringify({ error: validation.error }), { status: 400, headers });

        const currentWeek = getCurrentWeek();
        const challenge   = await env.DB.prepare(
          'SELECT id, challenge_targets, completed_targets, claimed FROM weekly_challenges WHERE username = ? AND week_number = ? ORDER BY created_at DESC LIMIT 1'
        ).bind(validation.clean, currentWeek).first();

        if (!challenge)
          return new Response(JSON.stringify({ error: 'لا يوجد تحدي' }), { status: 400, headers });

        // منع المطالبة المزدوجة
        if (challenge.claimed === 1)
          return new Response(JSON.stringify({ error: 'طالبت بالفعل' }), { status: 400, headers });

        const targets   = JSON.parse(challenge.challenge_targets  || '[]');
        const completed = JSON.parse(challenge.completed_targets   || '[]');

        // التأكد من إكمال جميع الأهداف
        if (completed.length !== targets.length)
          return new Response(JSON.stringify({ error: 'لم تكمل جميع الأهداف بعد' }), { status: 400, headers });

        // إنشاء تحدي جديد فوراً بعد الاستلام
        const newUsers = await env.DB.prepare(
          'SELECT username FROM users WHERE username != ? AND is_deleted = 0 ORDER BY RANDOM() LIMIT 3'
        ).bind(validation.clean).all();

        const newTargets = newUsers.results.map(u => u.username);

        await env.DB.batch([
          // تأشير التحدي الحالي كمُستلَم
          env.DB.prepare('UPDATE weekly_challenges SET claimed = 1 WHERE id = ?').bind(challenge.id),
          // المجموع الكلي (all-time) في جدول users — لا يُصفَّر أبداً
          env.DB.prepare(
            'UPDATE users SET total_silver_all_time = total_silver_all_time + 5 WHERE username = ?'
          ).bind(validation.clean),
          // نقاط الأسبوع الحالي في weekly_leaderboard — بدون أي حاجة للتصفير لاحقاً
          env.DB.prepare(
            `INSERT INTO weekly_leaderboard (username, week_number, gold_points, silver_points)
             VALUES (?, ?, 0, 5)
             ON CONFLICT(username, week_number) DO UPDATE SET silver_points = silver_points + 5`
          ).bind(validation.clean, currentWeek),
          // إدراج تحدي جديد فوراً لو يوجد مستخدمون
          ...(newTargets.length > 0 ? [env.DB.prepare(
            'INSERT INTO weekly_challenges (username, challenge_targets, completed_targets, claimed, week_number) VALUES (?, ?, ?, 0, ?)'
          ).bind(validation.clean, JSON.stringify(newTargets), JSON.stringify([]), currentWeek)] : [])
        ]);

        return new Response(JSON.stringify({
          success: true,
          message: '🎉 تمت إضافة 5 نقاط فضية!'
        }), { headers });

      } catch (err) {
        return new Response(JSON.stringify({ error: 'خطأ في الخادم' }), { status: 500, headers });
      }
    }

    // =========================================================================
    // GET /api/leaderboard — ترتيب الأسبوع
    // =========================================================================
    if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
      try {
        const week  = url.searchParams.get('week') || getCurrentWeek();
        const limit = Math.min(parseInt(url.searchParams.get('limit')) || 10, 100);

        // weekly_leaderboard هو المصدر الوحيد للحقيقة الآن — كل مستخدم نشط
        // له صف واحد بالضبط لكل أسبوع (username, week_number) يُنشأ تلقائياً
        // أول مرة يكسب نقطة فيها (INSERT ON CONFLICT في register/claim).
        // الترتيب يُحسب هنا مباشرة بـ ROW_NUMBER() بدلاً من عمود rank مخزَّن،
        // فلا حاجة لأي عملية "بناء" أو "تصفير" مسبقة — الاستعلام ذاتي الاكتفاء تماماً.
        const leaderboard = await env.DB.prepare(
          `SELECT username, gold_points, silver_points,
                  ROW_NUMBER() OVER (ORDER BY (gold_points + silver_points * 5) DESC) AS rank
           FROM weekly_leaderboard
           WHERE week_number = ?
           ORDER BY rank
           LIMIT ?`
        ).bind(week, limit).all();

        // لا يوجد أي مستخدم كسب نقاطاً هذا الأسبوع بعد — حالة طبيعية، وليست خطأ
        return new Response(JSON.stringify({ leaderboard: leaderboard.results, week }), { headers });

      } catch (err) {
        return new Response(JSON.stringify({ error: 'خطأ في الخادم' }), { status: 500, headers });
      }
    }

    return new Response('Not Found', { status: 404 });
  },

  // =========================================================================
  // scheduled — صيانة اختيارية فقط، ليست مطلوبة لعمل النظام الأسبوعي
  //
  // ملاحظة مهمة بعد التحديث: التصفير الأسبوعي لم يعد موجوداً كخطوة منفصلة.
  // كل أسبوع له صفوف مستقلة تماماً في weekly_leaderboard (username, week_number)
  // تُنشأ تلقائياً أول مرة يكسب فيها المستخدم نقطة (في /api/register أو
  // /api/challenge/claim عبر INSERT ... ON CONFLICT). الترتيب نفسه يُحسب
  // ديناميكياً في /api/leaderboard بـ ROW_NUMBER() في كل طلب — فلا يوجد أي
  // عمود "rank" مخزَّن يحتاج تحديثاً، ولا أي UPDATE شامل يمسح نقاط الجميع.
  //
  // الدالة هنا باقية فقط لتنظيف البيانات القديمة جداً (اختياري بالكامل):
  // - حذف تحديات أقدم من أسبوعين (تراكم غير ضروري في weekly_challenges)
  // - حذف صفوف ترتيب أقدم من 8 أسابيع (تراكم غير ضروري في weekly_leaderboard)
  // كلا العمليتين DELETE مباشر بدون قراءة/تكرار على كل مستخدم، فتكلفتهما
  // منخفضة جداً وثابتة، ولا علاقة لهما بآلية التصفير القديمة المُلغاة.
  //
  // بما إن الميزة الأساسية (التصفير الذاتي) لا تعتمد على هذه الدالة إطلاقاً،
  // فمن الآمن تمامًا ترك الموقع بدون Cron Trigger مفعّل (كما هو حالياً) —
  // كل شيء سيعمل بشكل صحيح وتلقائي بدونها.
  // =========================================================================
  async scheduled(event, env, ctx) {
    try {
      const currentWeek = getCurrentWeek();
      const oldChallengesBefore  = currentWeek - 2;
      const oldLeaderboardBefore = currentWeek - 8;

      await env.DB.batch([
        env.DB.prepare('DELETE FROM weekly_challenges WHERE week_number < ?').bind(oldChallengesBefore),
        env.DB.prepare('DELETE FROM weekly_leaderboard WHERE week_number < ?').bind(oldLeaderboardBefore)
      ]);

      console.log(`✅ صيانة دورية — حذف بيانات أقدم من الحد المسموح (الأسبوع الحالي: ${currentWeek})`);
    } catch (err) {
      console.error('Scheduled maintenance error:', err);
    }
  }
};
