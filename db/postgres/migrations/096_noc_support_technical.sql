-- Team trial round 12 (§11, §8): the NOC (NOC and Support merged, migration 037) is called NOC Support and
-- Technical, on screens and in our own e-mail signatures. Greetings to a partner's own NOC stay as they are.
UPDATE departments SET name = 'NOC Support and Technical'
 WHERE name = 'NOC' AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.name = 'NOC Support and Technical');
UPDATE email_templates
   SET body = replace(replace(body, E'\nPlatform NOC, {company}', E'\nNOC Support and Technical, {company}'),
                      E'\nNOC, {company}', E'\nNOC Support and Technical, {company}')
 WHERE body LIKE E'%\nPlatform NOC, {company}%' OR body LIKE E'%\nNOC, {company}%';
