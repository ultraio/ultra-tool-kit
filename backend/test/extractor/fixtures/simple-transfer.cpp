#include <eosio/eosio.hpp>

namespace fixture {

void simple::transfer(const name& from, const name& to, const asset& quantity, const string& memo)
{
    require_auth(from);
    check(from != to, "cannot transfer to self");
    check(quantity.amount > 0, "must transfer positive quantity");
    check(memo.size() <= 256, "memo has more than 256 bytes");
}

}
