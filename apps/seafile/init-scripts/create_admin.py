#!/usr/bin/env python3
"""
Seafile Admin User Initialization Script

Creates the admin user from environment variables if it doesn't exist.
This script should be run via Seafile's python-env wrapper:

    ./seahub.sh python-env python /opt/seafile/init-scripts/create_admin.py

Environment variables:
    SEAFILE_ADMIN_EMAIL - Admin email address
    SEAFILE_ADMIN_PASSWORD - Admin password

Note: Seafile 11 has a bug in create_superuser() that causes:
    "User matching query does not exits"
We work around this by using the raw CcnetUser model directly.
"""

import os
import sys


def create_admin_user():
    """Create admin user from environment variables if it doesn't exist."""
    from seahub.base.accounts import User
    from seaserv import ccnet_threaded_rpc
    from django.contrib.auth.hashers import make_password

    email = os.environ.get('SEAFILE_ADMIN_EMAIL', '').strip()
    password = os.environ.get('SEAFILE_ADMIN_PASSWORD', '').strip()

    if not email or not password:
        print('SEAFILE_ADMIN_EMAIL and SEAFILE_ADMIN_PASSWORD must be set')
        return False

    # Check if user already exists in database
    try:
        user = User.objects.get(email=email)
        print(f'Admin user already exists: {email}')
        return True
    except User.DoesNotExist:
        pass

    # Create the admin user using ccnet API (workaround for Seafile bug)
    try:
        # Use Django's make_password to create PBKDF2 hash (Seafile's default)
        password_hash = make_password(password)
        ccnet_threaded_rpc.add_emailuser(email, password_hash, 1, 1)
        print(f'Admin user created successfully: {email}')
        return True
    except Exception as e:
        print(f'Error with ccnet API, trying alternative: {e}')

        # Alternative: try the emailuser table directly via Django ORM
        try:
            from seahub.base.models import EmailUser
            # Create user in emailuser table with PBKDF2 hash
            password_hash = make_password(password)
            EmailUser.objects.create(
                email=email,
                password=password_hash,
                is_staff=True,
                is_active=True
            )
            print(f'Admin user created via EmailUser model: {email}')
            return True
        except Exception as e2:
            print(f'Error creating admin user: {e2}')
            return False


if __name__ == '__main__':
    # Setup Django (python-env should have set up the paths)
    import django
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'seahub.settings')
    django.setup()

    success = create_admin_user()
    sys.exit(0 if success else 1)
