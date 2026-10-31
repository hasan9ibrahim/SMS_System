# settings

No tasks: only `defaults/main.yml`, the settings every environment shares (versions, ports, the derived machine lists,
retention, application names). Every play in `site.yml` and `deploy.yml` lists this role first, so these are role
defaults: the lowest precedence in Ansible, below an inventory's `group_vars/all`. To change one for an environment, set
it in that inventory's `group_vars/all/main.yml` (or for one group or host); do not edit it here.
