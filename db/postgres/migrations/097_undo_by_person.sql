-- Team trial round 12 (§13.10): who may undo someone else's change follows the person (administrators, directors of
-- the Management department, the manager of that user's department), so the "undo_others" access-group action goes.
CREATE OR REPLACE FUNCTION pg_temp.drop_action(p jsonb, action text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce(jsonb_object_agg(e.key,
           CASE WHEN jsonb_typeof(e.value) = 'array'
                THEN (SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements(e.value) x
                       WHERE x <> to_jsonb(action))
                ELSE e.value END), '{}'::jsonb)
    FROM jsonb_each(p) e
$$;
UPDATE access_groups SET permissions = pg_temp.drop_action(permissions, 'undo_others')
 WHERE jsonb_typeof(permissions) = 'object' AND permissions::text LIKE '%undo_others%';
UPDATE users SET permission_overrides = pg_temp.drop_action(permission_overrides, 'undo_others')
 WHERE jsonb_typeof(permission_overrides) = 'object' AND permission_overrides::text LIKE '%undo_others%';
