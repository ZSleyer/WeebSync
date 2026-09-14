-- Historical-stage language tags ("enm" Middle English, "gmh" Middle High
-- German) were read as languages of their own: langCode knew a dozen modern
-- codes and title-cased everything else, so a mis-tagged track landed in a
-- copy's set as "Enm" beside the real "Eng". It matched nothing, and it made
-- the copy look like it carried one language more than it does - which is
-- exactly what the language axes count.
--
-- The map now reads those tags as the modern language. The rows already stored
-- still carry the invented codes, and they read as a complete account of a
-- copy's languages, so leaving them would keep the wrong comparisons alive
-- until each row happened to be rewritten.
--
-- Dropping the affected rows rather than rewriting the CSV in place: the lists
-- are sorted, so renaming a code can leave a duplicate that is no longer
-- adjacent ("Ger,Gle,Gmh" -> "Ger,Gle,Ger"), and de-duplicating a CSV in SQL
-- costs more than letting the row be measured again. There are only a handful.
--
-- They come back on their own and correctly: a server-0 row is rebuilt by
-- indexPlexLibrary on its next hourly tick, a remote row by variantRecheck
-- within 12h. The unit has no variant in between, which is the honest state -
-- the same trade 050_variant_soft_subs.sql made, and for the same reason the
-- plex_indexed_at gate is NOT cleared here: six rows do not justify forcing a
-- full re-index of the library.
DELETE FROM catalog_variants
 WHERE ',' || dub_codes  || ',' LIKE '%,Ang,%' OR ',' || dub_codes  || ',' LIKE '%,Enm,%'
    OR ',' || dub_codes  || ',' LIKE '%,Goh,%' OR ',' || dub_codes  || ',' LIKE '%,Gmh,%'
    OR ',' || dub_codes  || ',' LIKE '%,Fro,%' OR ',' || dub_codes  || ',' LIKE '%,Frm,%'
    OR ',' || sub_codes  || ',' LIKE '%,Ang,%' OR ',' || sub_codes  || ',' LIKE '%,Enm,%'
    OR ',' || sub_codes  || ',' LIKE '%,Goh,%' OR ',' || sub_codes  || ',' LIKE '%,Gmh,%'
    OR ',' || sub_codes  || ',' LIKE '%,Fro,%' OR ',' || sub_codes  || ',' LIKE '%,Frm,%'
    OR ',' || soft_codes || ',' LIKE '%,Ang,%' OR ',' || soft_codes || ',' LIKE '%,Enm,%'
    OR ',' || soft_codes || ',' LIKE '%,Goh,%' OR ',' || soft_codes || ',' LIKE '%,Gmh,%'
    OR ',' || soft_codes || ',' LIKE '%,Fro,%' OR ',' || soft_codes || ',' LIKE '%,Frm,%';

-- The suggestion blob is built from those rows and cached; it would keep
-- serving the old comparison until it next expired.
DELETE FROM anilist_cache WHERE key LIKE 'suggestions:%';
