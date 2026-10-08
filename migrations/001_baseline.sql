create schema if not exists shopping_app;

create table if not exists shopping_app.users(
  id uuid primary key,
  email text unique not null,
  password_hash text not null,
  display_name text not null default '',
  status text not null default 'active',
  app_role text not null default 'user',
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);
alter table shopping_app.users add column if not exists status text not null default 'active';
alter table shopping_app.users add column if not exists app_role text not null default 'user';
alter table shopping_app.users add column if not exists last_login_at timestamptz;

create table if not exists shopping_app.households(
  id uuid primary key,
  name text not null,
  invite_code text unique not null,
  created_by uuid not null references shopping_app.users(id),
  created_at timestamptz not null default now()
);

create table if not exists shopping_app.memberships(
  user_id uuid not null references shopping_app.users(id) on delete cascade,
  household_id uuid not null references shopping_app.households(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key(user_id,household_id)
);
create index if not exists memberships_user_idx on shopping_app.memberships(user_id);
create index if not exists memberships_household_idx on shopping_app.memberships(household_id);

create table if not exists shopping_app.sessions(
  token_hash text primary key,
  user_id uuid not null references shopping_app.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists sessions_user_idx on shopping_app.sessions(user_id);
create index if not exists sessions_expiry_idx on shopping_app.sessions(expires_at);

create table if not exists shopping_app.lists(
  id uuid primary key,
  household_id uuid not null references shopping_app.households(id) on delete cascade,
  owner_user_id uuid references shopping_app.users(id) on delete cascade,
  name text not null,
  type text not null check(type in ('personal','shared')),
  admin_visible boolean not null default true,
  created_by uuid not null references shopping_app.users(id),
  created_at timestamptz not null default now()
);
create unique index if not exists one_personal_list_per_user on shopping_app.lists(owner_user_id) where type='personal';
create index if not exists lists_household_idx on shopping_app.lists(household_id);

create table if not exists shopping_app.list_memberships(
  list_id uuid not null references shopping_app.lists(id) on delete cascade,
  user_id uuid not null references shopping_app.users(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key(list_id,user_id)
);
create index if not exists list_memberships_user_idx on shopping_app.list_memberships(user_id);

create table if not exists shopping_app.items(
  id uuid primary key,
  household_id uuid not null references shopping_app.households(id) on delete cascade,
  list_id uuid references shopping_app.lists(id) on delete cascade,
  name text not null,
  quantity numeric not null default 1,
  unit text not null default 'τεμ.',
  category text not null default 'Άλλα',
  store text not null default '',
  note text not null default '',
  priority text not null default 'normal',
  status text not null default 'active',
  created_by uuid not null references shopping_app.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  purchased_at timestamptz,
  version integer not null default 1,
  deleted_at timestamptz,
  deleted_by uuid references shopping_app.users(id)
);
alter table shopping_app.items add column if not exists list_id uuid references shopping_app.lists(id) on delete cascade;
alter table shopping_app.items add column if not exists version integer not null default 1;
alter table shopping_app.items add column if not exists deleted_at timestamptz;
alter table shopping_app.items add column if not exists deleted_by uuid references shopping_app.users(id);
create index if not exists items_list_idx on shopping_app.items(list_id,status,updated_at desc);

create table if not exists shopping_app.activity(
  id uuid primary key,
  household_id uuid not null references shopping_app.households(id) on delete cascade,
  list_id uuid references shopping_app.lists(id) on delete cascade,
  user_id uuid not null references shopping_app.users(id),
  action text not null,
  item_name text,
  created_at timestamptz not null default now()
);
alter table shopping_app.activity add column if not exists list_id uuid references shopping_app.lists(id) on delete cascade;
create index if not exists activity_list_idx on shopping_app.activity(list_id,created_at desc);

update shopping_app.users u set app_role='admin',status='active'
where exists(select 1 from shopping_app.households h where h.created_by=u.id);

insert into shopping_app.lists(id,household_id,owner_user_id,name,type,admin_visible,created_by)
select gen_random_uuid(),h.id,null,'Κοινή λίστα','shared',true,h.created_by
from shopping_app.households h
where not exists(select 1 from shopping_app.lists l where l.household_id=h.id and l.type='shared');

insert into shopping_app.list_memberships(list_id,user_id,role)
select l.id,m.user_id,case when m.role='owner' then 'owner' else 'member' end
from shopping_app.lists l
join shopping_app.memberships m on m.household_id=l.household_id
where l.type='shared'
on conflict do nothing;

update shopping_app.items i set list_id=(
  select l.id from shopping_app.lists l
  where l.household_id=i.household_id and l.type='shared'
  order by l.created_at limit 1
) where i.list_id is null;
