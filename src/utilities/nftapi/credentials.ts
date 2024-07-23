// These are meant to be exposed. No security concern here.
export default {
    prod: {
        headers: {
            'X-Client-ID': 'toolkit',
        },
        url: 'https://api.ultra.io/graphql',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCIgOiAiSldUIiwia2lkIiA6ICI5OTAyZWM5Ni1jODc3LTRlMDItOTYxYS00YjliZTdiMTRlMzgifQ.eyJleHAiOjAsImlhdCI6MTcwMTc4ODE4OSwianRpIjoiZDg0MjcxODEtMzMzZS00NjFmLTlmZTQtMjI4NzI2MmY4OWFiIiwiaXNzIjoiaHR0cHM6Ly9hdXRoLnVsdHJhLmlvL2F1dGgvcmVhbG1zL3VsdHJhaW8iLCJhdWQiOiJodHRwczovL2F1dGgudWx0cmEuaW8vYXV0aC9yZWFsbXMvdWx0cmFpbyIsInR5cCI6IlJlZ2lzdHJhdGlvbkFjY2Vzc1Rva2VuIiwicmVnaXN0cmF0aW9uX2F1dGgiOiJhdXRoZW50aWNhdGVkIn0.GweRIOfcxviYK_1tekxtHkRYw9yl3qN458D1puyJ6O8',
    },
    staging: {
        headers: {
            'X-Client-ID': 'toolkit',
        },
        url: 'https://staging.api.ultra.io/graphql',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCIgOiAiSldUIiwia2lkIiA6ICI5OTAyZWM5Ni1jODc3LTRlMDItOTYxYS00YjliZTdiMTRlMzgifQ.eyJleHAiOjAsImlhdCI6MTcwMTc4ODExMSwianRpIjoiODU4OWFiZGItMDQ3ZC00MGRkLWE0ZjUtN2NjNThjNzEwMDljIiwiaXNzIjoiaHR0cHM6Ly9hdXRoLnN0YWdpbmcudWx0cmEuaW8vYXV0aC9yZWFsbXMvdWx0cmFpbyIsImF1ZCI6Imh0dHBzOi8vYXV0aC5zdGFnaW5nLnVsdHJhLmlvL2F1dGgvcmVhbG1zL3VsdHJhaW8iLCJ0eXAiOiJSZWdpc3RyYXRpb25BY2Nlc3NUb2tlbiIsInJlZ2lzdHJhdGlvbl9hdXRoIjoiYXV0aGVudGljYXRlZCJ9.V_wmLXSAl1lZFRRf-vfrDAKKlNYD1DD76Ix9UOEZ0Ns',
    },
    preprod: {
        headers: {
            'X-Client-ID': 'toolkit',
        },
        url: 'https://preprod.api.ultra.io/graphql',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCIgOiAiSldUIiwia2lkIiA6ICIzMThiZjUxYS1kN2JlLTQzNWYtYWRhZC05MGNlZjlmZWY1ZTYifQ.eyJleHAiOjAsImlhdCI6MTcwMTc4ODEzOCwianRpIjoiYjExYTQwZDctOTc4ZC00MDBlLTliMTktOTA0ZjU3OWNkNmZmIiwiaXNzIjoiaHR0cHM6Ly9hdXRoLnByZXByb2QudWx0cmEuaW8vYXV0aC9yZWFsbXMvdWx0cmFpbyIsImF1ZCI6Imh0dHBzOi8vYXV0aC5wcmVwcm9kLnVsdHJhLmlvL2F1dGgvcmVhbG1zL3VsdHJhaW8iLCJ0eXAiOiJSZWdpc3RyYXRpb25BY2Nlc3NUb2tlbiIsInJlZ2lzdHJhdGlvbl9hdXRoIjoiYXV0aGVudGljYXRlZCJ9._Pm7DjgZGZNzGnXve07MxsKF9HLVJBSAVYiePsdmYa8',
    },
    qa: {
        headers: {
            'X-Client-ID': 'toolkit',
        },
        url: 'https://qa.api.ultra.io/graphql',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCIgOiAiSldUIiwia2lkIiA6ICI5OTAyZWM5Ni1jODc3LTRlMDItOTYxYS00YjliZTdiMTRlMzgifQ.eyJleHAiOjAsImlhdCI6MTcwMTc4ODE1NSwianRpIjoiNzU3YWU5ODgtMmI0Yy00ZWE4LThmODQtNTFjNDkwMTI5Zjg5IiwiaXNzIjoiaHR0cHM6Ly9hdXRoLnFhLnVsdHJhLmlvL2F1dGgvcmVhbG1zL3VsdHJhaW8iLCJhdWQiOiJodHRwczovL2F1dGgucWEudWx0cmEuaW8vYXV0aC9yZWFsbXMvdWx0cmFpbyIsInR5cCI6IlJlZ2lzdHJhdGlvbkFjY2Vzc1Rva2VuIiwicmVnaXN0cmF0aW9uX2F1dGgiOiJhdXRoZW50aWNhdGVkIn0.kqsbucQt4NRIRQvLgc4LYDWnz_6RQWKyuGsvnqvjoXc',
    },
    dev: {
        headers: {
            'X-Client-ID': 'toolkit',
        },
        url: 'https://dev.api.ultra.io/graphql',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCIgOiAiSldUIiwia2lkIiA6ICI5OTAyZWM5Ni1jODc3LTRlMDItOTYxYS00YjliZTdiMTRlMzgifQ.eyJleHAiOjAsImlhdCI6MTcwMTc4ODE3MywianRpIjoiZjg2ODE0ZjUtN2UxZC00MjRhLWIyMTgtYWNkNzkwYjJiMzFkIiwiaXNzIjoiaHR0cHM6Ly9hdXRoLmRldi51bHRyYS5pby9hdXRoL3JlYWxtcy91bHRyYWlvIiwiYXVkIjoiaHR0cHM6Ly9hdXRoLmRldi51bHRyYS5pby9hdXRoL3JlYWxtcy91bHRyYWlvIiwidHlwIjoiUmVnaXN0cmF0aW9uQWNjZXNzVG9rZW4iLCJyZWdpc3RyYXRpb25fYXV0aCI6ImF1dGhlbnRpY2F0ZWQifQ.aAU495N7axKyqWeTp2nkxHUD3Tb82ZFa-K3ORcbEbmE',
    },
};
