UPDATE skins
SET release_date = CASE codename
    WHEN 'base' THEN '2010-03-16'
    WHEN 'nottingham' THEN '2010-03-16'
    WHEN 'striker' THEN '2010-06-24'
    WHEN 'frosted' THEN '2010-07-18'
    WHEN 'explorer' THEN '2010-10-13'
    WHEN 'pulsefire' THEN '2012-06-29'
    WHEN 'tpa' THEN '2013-05-23'
    WHEN 'debonair' THEN '2014-08-05'
    WHEN 'ace-of-spades' THEN '2015-05-20'
    WHEN 'arcade' THEN '2016-08-24'
    WHEN 'star-guardian' THEN '2017-09-06'
    WHEN 'ssg' THEN '2018-07-20'
    WHEN 'pajama-guardian' THEN '2018-11-21'
    WHEN 'battle-academia' THEN '2019-05-15'
    WHEN 'psyops' THEN '2020-09-03'
    WHEN 'prestige-psyops' THEN '2020-09-03'
    WHEN 'porcelain-protector' THEN '2022-01-26'
    WHEN 'faerie-court' THEN '2023-05-23'
    WHEN 'heartsteel' THEN '2023-11-08'
    WHEN 'heavenscale' THEN '2024-02-07'
    WHEN 'prestige-heavenscale' THEN '2024-02-07'
    WHEN 'black-rose' THEN '2025-01-09'
    WHEN 'crystal-rose' THEN '2021-12-14'
    WHEN 'lovestruck' THEN '2024-02-14'
    WHEN 'weather-entity' THEN '2025-04-30'
    WHEN 'prestige-weather-entity' THEN '2025-04-30'
    WHEN 'love-confession' THEN '2026-02-13'
    WHEN 'prestige-love-confession' THEN '2026-02-13'
    -- User-provided placeholders until exact dates are available.
    WHEN 'other' THEN '2010-01-01'
    WHEN 'dream-of-the-red-chamber' THEN '2026-01-01'
    WHEN 'hidden-dragon' THEN '2024-01-01'
    WHEN 'ink-keeper' THEN '2025-01-01'
    WHEN 'jarro-lightfeather' THEN '2023-01-01'
    WHEN 'prestige-porcelain-protector' THEN '2025-01-01'
    WHEN 'heartsteel-2026' THEN '2026-01-01'
    ELSE release_date
END
WHERE codename IN (
    'base', 'nottingham', 'striker', 'frosted', 'explorer', 'pulsefire', 'tpa',
    'debonair', 'ace-of-spades', 'arcade', 'star-guardian', 'ssg', 'pajama-guardian',
    'battle-academia', 'psyops', 'prestige-psyops', 'porcelain-protector', 'faerie-court',
    'heartsteel', 'heavenscale', 'prestige-heavenscale', 'black-rose', 'crystal-rose',
    'lovestruck', 'weather-entity', 'prestige-weather-entity', 'love-confession',
    'prestige-love-confession', 'other', 'dream-of-the-red-chamber', 'hidden-dragon',
    'ink-keeper', 'jarro-lightfeather', 'prestige-porcelain-protector', 'heartsteel-2026'
);